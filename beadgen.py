"""
拼豆图纸生成 —— 核心模块
管线: 平滑 → 等比缩放到网格 → 背景剥离 → 全局 k-means 减色(Lab)
      → 每个聚类色匹配最近拼豆色号 → 去孤立噪点 → 渲染指导图 + 配料清单
对照现成工具的"逐格直接量化",这里多了"全局减色 + 去噪",照片不再杂乱。
"""
from collections import deque, Counter
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
from skimage import color as skcolor
from skimage.segmentation import felzenszwalb
from sklearn.cluster import KMeans

# ---- 拼豆色板：可切换的「上层颜色适配层」----
# 色板就是一份 {色号 -> RGB} 的映射。换色卡 = 换一份 json + 在 _REGISTRY 注册一行，
# 核心算法完全不动。运行时用 set_palette() 切换当前色板。
import json as _json, os as _os

_DIR = _os.path.dirname(_os.path.abspath(__file__))

_FALLBACK = {
    "白": (255, 255, 255), "黑": (26, 26, 26), "浅灰": (185, 185, 185),
    "深灰": (105, 105, 105), "大红": (200, 40, 45), "橙": (240, 140, 30),
    "黄": (245, 200, 40), "金黄": (240, 170, 25), "浅绿": (140, 190, 90),
    "草绿": (90, 160, 70), "深绿": (45, 95, 55), "墨绿": (28, 68, 44),
    "天蓝": (90, 160, 215), "蓝": (40, 90, 175), "深蓝": (30, 50, 110),
    "紫": (120, 70, 150), "粉": (240, 150, 175), "棕": (120, 75, 45),
    "肤": (245, 215, 185), "米黄": (235, 225, 200),
}

# 注册表：显示名 -> json 文件名（相对本文件所在目录）。available_palettes()
# 会过滤掉不存在的文件，所以加 211/216/其他品牌只需在此加一行 + 把 json 放进 palettes/。
_REGISTRY = {
    "MARD 221 标准色卡": "palettes/mard221.json",
    "全色板 291（含特殊色）": "palettes/full291.json",  # 可选，不在公开仓库
}


def available_palettes():
    """返回 {显示名(N色): 文件路径}，只列出实际存在的色板。"""
    out = {}
    for disp, fn in _REGISTRY.items():
        p = _os.path.join(_DIR, fn)
        if _os.path.exists(p):
            n = len(_json.load(open(p, encoding="utf-8")))
            out[f"{disp}（{n}色）"] = p
    return out


def _load_file(path):
    d = _json.load(open(path, encoding="utf-8"))
    return {k: tuple(v) for k, v in d.items()}


# 当前生效色板（模块级，set_palette 切换；process/render 都读它）
PALETTE, NAMES, _PAL_RGB, _PAL_LAB = {}, [], None, None


def set_palette(source=None):
    """切换当前色板。source 可为 json 路径、{色号:RGB} 字典，或 None(默认 palette.json/兜底)。"""
    global PALETTE, NAMES, _PAL_RGB, _PAL_LAB
    if isinstance(source, dict):
        PALETTE = {k: tuple(v) for k, v in source.items()}
    elif isinstance(source, str) and _os.path.exists(source):
        PALETTE = _load_file(source)
    else:
        default = _os.path.join(_DIR, "palettes", "mard221.json")
        PALETTE = _load_file(default) if _os.path.exists(default) else dict(_FALLBACK)
    NAMES = list(PALETTE.keys())
    _PAL_RGB = np.array([PALETTE[n] for n in NAMES], dtype=np.float64)
    _PAL_LAB = skcolor.rgb2lab(_PAL_RGB.reshape(-1, 1, 3) / 255.0).reshape(-1, 3)
    return PALETTE


set_palette()  # 启动时载入默认色板


def _nearest_bead(rgb):
    """RGB(0-255) -> 最近拼豆色号 index（Lab ΔE 最近邻，比 RGB 更贴人眼）"""
    lab = skcolor.rgb2lab(np.array(rgb, float).reshape(1, 1, 3) / 255.0).reshape(3)
    return int(np.argmin(np.linalg.norm(_PAL_LAB - lab, axis=1)))


def _nearest_all(arr_rgb):
    """逐格匹配：每个格子直接最近邻到色板（保细节，不做全局减色）。arr_rgb:(h,w,3) 0-255"""
    h, w, _ = arr_rgb.shape
    lab = skcolor.rgb2lab(arr_rgb.reshape(-1, 1, 3) / 255.0).reshape(-1, 3)
    d = np.linalg.norm(lab[:, None, :] - _PAL_LAB[None, :, :], axis=2)
    return d.argmin(axis=1).reshape(h, w)


def _merge_similar(grid, fg, delta=10, target=24):
    """凝聚式合并：反复把「用量较少」的色号并入色板里 Lab 最近的「保留色」，
    直到色数≤target 或最近的两色 ΔE>delta。保细节的同时压低色号数。"""
    from collections import Counter as _C
    out = grid.copy()
    while True:
        cnt = _C(int(v) for v in out.reshape(-1) if v >= 0)
        used = list(cnt)
        if len(used) <= 2:
            break
        labs = _PAL_LAB[used]
        D = np.linalg.norm(labs[:, None, :] - labs[None, :, :], axis=2)
        np.fill_diagonal(D, 1e9)
        i, j = np.unravel_index(D.argmin(), D.shape)
        if len(used) <= target and D[i, j] > delta:
            break
        # 用量少的并入用量多的
        a, b = used[i], used[j]
        lose, keep = (a, b) if cnt[a] <= cnt[b] else (b, a)
        out[out == lose] = keep
    return out


def _remove_white_bg(arr, thresh):
    """从四角洪水填充剥离近白背景，返回 mask(True=前景)"""
    h, w, _ = arr.shape
    bright = arr.sum(axis=2) > thresh * 3
    bg = np.zeros((h, w), bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if bright[y, x]:
                bg[y, x] = True; dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if bright[y, x]:
                bg[y, x] = True; dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and bright[ny, nx] and not bg[ny, nx]:
                bg[ny, nx] = True; dq.append((ny, nx))
    return ~bg


def _despeckle(grid, fg_mask):
    """去孤立噪点：若某格颜色与周围多数不同，则改成周围多数色（清边缘杂点）"""
    h, w = grid.shape
    out = grid.copy()
    for y in range(h):
        for x in range(w):
            if not fg_mask[y, x]:
                continue
            neigh = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and fg_mask[ny, nx]:
                        neigh.append(grid[ny, nx])
            if not neigh:
                continue
            mode, cnt = Counter(neigh).most_common(1)[0]
            if mode != grid[y, x] and cnt >= 5:   # 周围 ≥5 个邻居都是另一色 → 同化
                out[y, x] = mode
    return out


def _flatten(img, strength):
    """二维化：图像分割(felzenszwalb)把图切成遵循真实边界的大色块，每块填均色，
    得到利落的卡通/扁平效果。比双边模糊干净（不会让颜色互相渗透）。
    strength 1~3 越大色块越大越平。先降到工作尺寸再分割，兼顾质量与速度。"""
    if strength <= 0:
        return img
    work = img.copy()
    work.thumbnail((640, 640), Image.LANCZOS)
    arr = np.asarray(work).astype(np.float64) / 255.0
    scale = {1: 180, 2: 320, 3: 560}[strength]
    min_size = {1: 40, 2: 80, 3: 140}[strength]
    seg = felzenszwalb(arr, scale=scale, sigma=0.8, min_size=min_size)
    flat = arr.reshape(-1, 3).copy()
    lbl = seg.reshape(-1)
    for u in np.unique(lbl):
        m = lbl == u
        flat[m] = arr.reshape(-1, 3)[m].mean(axis=0)
    out = Image.fromarray((np.clip(flat.reshape(arr.shape), 0, 1) * 255).astype(np.uint8))
    return out.resize(img.size, Image.LANCZOS)


def _erode(fg, n):
    """边缘收缩 n 格：去掉主体最外圈，清掉照片边缘的半透明光晕。"""
    for _ in range(n):
        h, w = fg.shape
        keep = fg.copy()
        for y in range(h):
            for x in range(w):
                if not fg[y, x]:
                    continue
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if not (0 <= ny < h and 0 <= nx < w) or not fg[ny, nx]:
                        keep[y, x] = False; break
        fg = keep
    return fg


def _autocrop(img, bg_thresh, pad_frac=0.02):
    """裁掉四周白背景，让主体占满画面（不浪费网格分辨率在空白上）。"""
    import numpy as _np
    a = _np.asarray(img).astype(_np.int32)
    fg = a.sum(axis=2) <= bg_thresh * 3
    ys, xs = _np.where(fg)
    if len(xs) == 0:
        return img
    pad = int(max(img.width, img.height) * pad_frac)
    x0, x1 = max(0, xs.min() - pad), min(img.width, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(img.height, ys.max() + 1 + pad)
    return img.crop((x0, y0, x1, y1))


def _consolidate(grid, fg, min_cells):
    """最小色块面积：用量 < min_cells 的稀有色，逐格并入其邻居中最多的保留色。
    既去阴影杂点，又进一步压低色号总数（对手工拼豆更友好）。"""
    if min_cells <= 0:
        return grid
    h, w = grid.shape
    counts = Counter(int(v) for v in grid.reshape(-1) if v >= 0)
    rare = {b for b, c in counts.items() if c < min_cells}
    if not rare:
        return grid
    out = grid.copy()
    # 多轮，让稀有色逐圈被吞掉
    for _ in range(6):
        changed = False
        cur = Counter(int(v) for v in out.reshape(-1) if v >= 0)
        rare = {b for b, c in cur.items() if c < min_cells}
        if not rare:
            break
        for y in range(h):
            for x in range(w):
                v = out[y, x]
                if v < 0 or v not in rare:
                    continue
                nb = Counter()
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if dy == 0 and dx == 0:
                            continue
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and out[ny, nx] >= 0 \
                           and out[ny, nx] not in rare:
                            nb[int(out[ny, nx])] += 1
                if nb:
                    out[y, x] = nb.most_common(1)[0][0]; changed = True
        if not changed:
            break
    return out


def process(img, grid_w=110, k=6, remove_bg=True, bg_thresh=235,
            flatten=1, despeckle=True, edge_trim=1, autocrop=True,
            saturation=1.2, min_area=20, detail=False, max_colors=24, merge_delta=10):
    """
    返回: grid_ids(h×w, 拼豆色号index, 背景=-1), used(色号index列表), counts(名->颗数)
    detail=True：保细节模式（适合 AI 卡通/像素/logo 这类已经干净的图）——
      逐格匹配保锐利，再按 ΔE 合并相近色压到 max_colors，不做 felzenszwalb/k-means 磨平。
    """
    img = img.convert("RGB")
    if autocrop and remove_bg:
        img = _autocrop(img, bg_thresh)
    if saturation != 1.0:
        img = ImageEnhance.Color(img).enhance(saturation)
    ar = img.height / img.width
    grid_h = max(1, round(grid_w * ar))

    # 背景蒙版用「原图」算（拍平会污染白底边缘，必须先于拍平）
    small_orig = np.asarray(img.resize((grid_w, grid_h), Image.LANCZOS)).astype(np.uint8)
    fg = (_remove_white_bg(small_orig, bg_thresh) if remove_bg
          else np.ones((grid_h, grid_w), bool))
    if remove_bg and edge_trim > 0:
        fg = _erode(fg, edge_trim)
    fg_flat = fg.reshape(-1)
    if int(fg_flat.sum()) == 0:
        fg = np.ones((grid_h, grid_w), bool); fg_flat = fg.reshape(-1)

    if detail:
        # 保细节：逐格匹配（不拍平、不 k-means）→ ΔE 合并相近色
        grid = _nearest_all(small_orig)
        grid[~fg] = -1
        grid = _merge_similar(grid, fg, delta=merge_delta, target=max_colors)
    else:
        # 去噪模式：拍平 + 全局 k-means 减色（适合嘈杂照片）
        flat = _flatten(img, flatten)
        arr = np.asarray(flat.resize((grid_w, grid_h), Image.LANCZOS)).astype(np.float64)
        lab = skcolor.rgb2lab(arr / 255.0).reshape(-1, 3)
        n_fg = int(fg_flat.sum())
        km = KMeans(n_clusters=min(k, n_fg), n_init=4, random_state=0)
        cl = km.fit_predict(lab[fg_flat])
        labels = np.full(grid_w * grid_h, -1)
        labels[fg_flat] = cl
        centers_rgb = skcolor.lab2rgb(km.cluster_centers_.reshape(-1, 1, 3)).reshape(-1, 3) * 255
        cluster_to_bead = [_nearest_bead(c) for c in centers_rgb]
        grid = np.full((grid_h, grid_w), -1)
        for i, lb in enumerate(labels):
            if lb >= 0:
                grid[i // grid_w, i % grid_w] = cluster_to_bead[lb]

    if despeckle:
        grid = _despeckle(grid, fg)
    if min_area > 0:
        grid = _consolidate(grid, fg, min_area)

    counts = Counter()
    for v in grid.reshape(-1):
        if v >= 0:
            counts[NAMES[v]] += 1
    used = sorted({v for v in grid.reshape(-1) if v >= 0},
                  key=lambda b: -counts[NAMES[b]])
    return grid, used, dict(counts)


def render(grid, used, cell=22, show_grid=True, show_ids=True):
    """渲染指导图：每格填色 + 标编号(1,2,3...)；右侧不画图例(界面里单列)"""
    h, w = grid.shape
    bead_to_num = {b: i + 1 for i, b in enumerate(used)}
    canvas = Image.new("RGB", (w * cell + 1, h * cell + 1), (237, 234, 224))
    d = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf",
                                  max(8, cell // 2))
    except Exception:
        font = ImageFont.load_default()
    for y in range(h):
        for x in range(w):
            b = grid[y, x]
            if b < 0:
                continue
            r, g, bl = PALETTE[NAMES[b]]
            d.rectangle([x * cell, y * cell, x * cell + cell, y * cell + cell],
                        fill=(r, g, bl),
                        outline=(200, 200, 200) if show_grid else None)
            if show_ids and cell >= 14:
                num = str(bead_to_num[b])
                tc = (0, 0, 0) if (r + g + bl) > 360 else (255, 255, 255)
                tb = d.textbbox((0, 0), num, font=font)
                tx = x * cell + (cell - (tb[2] - tb[0])) / 2
                ty = y * cell + (cell - (tb[3] - tb[1])) / 2 - tb[1]
                d.text((tx, ty), num, fill=tc, font=font)
    return canvas, bead_to_num


def render_preview(grid, cell=16, bg=(245, 243, 237)):
    """成品效果预览：用圆豆子渲染（无数字、无网格），一眼看出像不像那个物品。"""
    h, w = grid.shape
    img = Image.new("RGB", (w * cell, h * cell), bg)
    d = ImageDraw.Draw(img)
    pad = max(1, cell * 0.10)
    for y in range(h):
        for x in range(w):
            b = grid[y, x]
            if b < 0:
                continue
            d.ellipse([x * cell + pad, y * cell + pad,
                       (x + 1) * cell - pad, (y + 1) * cell - pad],
                      fill=PALETTE[NAMES[b]])
    return img


def _cjk_font(size):
    """找一个支持中文的字体（跨 macOS/Linux），找不到退化到默认。"""
    for p in ("/System/Library/Fonts/PingFang.ttc",
              "/System/Library/Fonts/STHeiti Light.ttc",
              "/System/Library/Fonts/Hiragino Sans GB.ttc",
              "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
              "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"):
        if _os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _legend_image(used, counts, bead_to_num, width=1240):
    """配料图例：编号 + 色块 + 色号 + 颗数，多列排布。"""
    font = _cjk_font(22)
    fontb = _cjk_font(30)
    cols = 3
    rowh, sw = 40, 30
    per = (len(used) + cols - 1) // cols
    colw = width // cols
    total = sum(counts.values())
    H = 90 + per * rowh + 40
    img = Image.new("RGB", (width, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.text((20, 24), f"配料清单  ·  共 {total} 颗  ·  {len(used)} 种色  "
                     f"(色卡: {len(NAMES)}色)", fill=(0, 0, 0), font=fontb)
    for i, b in enumerate(used):
        c, r = divmod(i, per)
        x = 20 + c * colw
        y = 90 + r * rowh
        col = PALETTE[NAMES[b]]
        d.rectangle([x, y, x + sw, y + sw], fill=col, outline=(0, 0, 0))
        tc = (0, 0, 0) if sum(col) > 360 else (255, 255, 255)
        d.text((x + 8, y + 5), str(bead_to_num[b]), fill=tc, font=font)
        d.text((x + sw + 12, y + 4),
               f"{NAMES[b]:<5} × {counts[NAMES[b]]}", fill=(0, 0, 0), font=font)
    return img


def build_pdf(grid, used, counts):
    """生成可打印 PDF：第1页色号指导图，第2页配料图例。返回 bytes。"""
    import io as _io
    guide, b2n = render(grid, used, cell=26, show_grid=True, show_ids=True)
    legend = _legend_image(used, counts, b2n)
    buf = _io.BytesIO()
    guide.convert("RGB").save(buf, format="PDF", save_all=True,
                              append_images=[legend.convert("RGB")], resolution=150)
    return buf.getvalue()
