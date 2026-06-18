"""
拼豆图纸生成器 —— 本地调参网页
运行: .venv/bin/streamlit run app.py
"""
import io
import os
import streamlit as st
from PIL import Image
import beadgen
import redraw

st.set_page_config(page_title="拼豆图纸生成器", layout="wide")
st.title("🧩 拼豆图纸生成器")
st.caption("上传图片 →（照片建议开 AI 卡通化）→ 生成成品预览 + 色号指导图 + 配料清单。"
           "目标不是还原照片，而是干净地体现这个物品/宠物。")


def get_api_key():
    """优先 Streamlit secrets（部署用），其次环境变量/.env（本地用）。没有就返回 None。"""
    try:
        if "OPENROUTER_API_KEY" in st.secrets:
            return st.secrets["OPENROUTER_API_KEY"]
    except Exception:
        pass
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    try:
        return redraw._api_key()  # 读 .env
    except Exception:
        return None


@st.cache_data(show_spinner=False)
def ai_redraw_cached(img_bytes, prompt, api_key):
    """按图片内容+提示词缓存，拖动其它滑块不会重复花钱调 API。"""
    img = Image.open(io.BytesIO(img_bytes))
    return redraw.redraw(img, prompt=prompt or None, api_key=api_key)


with st.sidebar:
    st.header("参数")
    up = st.file_uploader("上传图片", type=["png", "jpg", "jpeg", "webp"])
    st.subheader("① AI 卡通化（照片必开）")
    use_ai = st.checkbox("照片 → 干净卡通贴纸", value=False,
                         help="毛茸茸/复杂背景的真实照片，先用 AI 重画成扁平卡通再转豆。约 $0.04/张。")
    ai_prompt = st.text_area("重画指令（可留空用默认）", value="", height=80,
                             disabled=not use_ai,
                             placeholder="留空=默认(宠物→卡通贴纸)。可写：把它画成戴帽子的卡通小狗…")
    st.subheader("② 色卡（可切换）")
    _pals = beadgen.available_palettes()
    pal_disp = st.selectbox("拼豆色卡", list(_pals.keys()), index=0,
                            help="选你老婆那盒豆子对应的标准。换色卡只换颜色匹配，不影响算法。")
    beadgen.set_palette(_pals[pal_disp])

    st.subheader("③ 拼豆参数")
    grid_w = st.slider("网格宽度（格子数）", 20, 180, 100, step=1,
                       help="对应拼豆板大小。越大越清晰、小特征(如logo)越能保住，但越费豆。")
    k = st.slider("颜色数量（k）", 2, 24, 6, step=1,
                  help="整图压成几种色。照片调小(4~6)最干净。")
    flatten = st.select_slider("二维化强度（去 3D/纹理）", options=[0, 1, 2, 3], value=1,
                               help="分割拍平阴影/高光/纹理。1=推荐；调太大会糊掉小字/logo。")
    saturation = st.slider("鲜艳度增强", 1.0, 1.8, 1.2, step=0.1,
                           help="把柔和/阴影色推向本色，减少误配成杂色（如暗黄→橄榄绿）。")
    min_area = st.slider("最小色块（颗）", 0, 80, 20, step=5,
                         help="用量少于此数的杂色并入邻色。越大色号越少越好拼，但小细节会被吞。")
    st.divider()
    remove_bg = st.checkbox("剥离白色背景", value=True)
    autocrop = st.checkbox("自动裁剪到主体（强烈建议）", value=True,
                           help="裁掉四周空白，让主体占满画面，分辨率不浪费在背景上。")
    bg_thresh = st.slider("背景白度阈值", 180, 255, 235, step=5, disabled=not remove_bg)
    edge_trim = st.slider("边缘收缩（去光晕）", 0, 3, 1, step=1, disabled=not remove_bg,
                          help="去掉主体最外圈的半透明光晕。")
    despeckle = st.checkbox("去孤立噪点", value=True)

if up is None:
    st.info("👈 在左侧上传一张图片开始。简单物品 / logo / 卡通效果最好。")
    st.stop()

raw = up.getvalue()
src = Image.open(io.BytesIO(raw))
cartoon = None
if use_ai:
    api_key = get_api_key()
    if not api_key:
        st.warning("此公开版未配置 AI key。如需「照片→卡通化」：fork 本仓库，"
                   "在 Streamlit secrets 或 .env 里填入你自己的 OpenRouter API key 即可。"
                   "不需要的话，取消勾选「AI 卡通化」也能正常出图（适合卡通/像素/logo）。")
        st.stop()
    try:
        with st.spinner("AI 卡通化中（约 20 秒）…"):
            cartoon = ai_redraw_cached(raw, ai_prompt, api_key)
        bead_src = cartoon
    except Exception as e:
        st.error(f"AI 重画失败：{e}")
        st.stop()
else:
    bead_src = src

grid, used, counts = beadgen.process(
    bead_src, grid_w=grid_w, k=k, remove_bg=remove_bg, bg_thresh=bg_thresh,
    flatten=flatten, despeckle=despeckle, edge_trim=edge_trim, autocrop=autocrop,
    saturation=saturation, min_area=min_area)
guide, bead_to_num = beadgen.render(grid, used, cell=22, show_grid=True, show_ids=True)
preview = beadgen.render_preview(grid, cell=16)

if cartoon is not None:
    c0, c1, c2, c3 = st.columns(4)
    with c0:
        st.subheader("原图")
        st.image(src, use_container_width=True)
    with c1:
        st.subheader("AI 卡通化")
        st.image(cartoon, use_container_width=True)
else:
    c1, c2, c3 = st.columns(3)
    with c1:
        st.subheader("原图")
        st.image(src, use_container_width=True)
with c2:
    st.subheader("成品预览（圆豆）")
    st.image(preview, use_container_width=True)
with c3:
    st.subheader(f"色号指导图 {grid.shape[1]}×{grid.shape[0]}")
    st.image(guide, use_container_width=True)

total = sum(counts.values())
st.subheader(f"配料清单　·　共 {total} 颗　·　{len(used)} 种色")
st.table([{"色号": bead_to_num[b], "颜色": beadgen.NAMES[b],
           "颗数": counts[beadgen.NAMES[b]]} for b in used])

d1, d2, d3 = st.columns(3)
for col, img, name, label in [
    (d1, preview, "拼豆成品预览.png", "⬇️ 成品预览 PNG"),
    (d2, guide, "拼豆色号指导图.png", "⬇️ 指导图 PNG")]:
    buf = io.BytesIO(); img.save(buf, format="PNG")
    col.download_button(label, buf.getvalue(), file_name=name, mime="image/png")
d3.download_button("⬇️ 打印版 PDF（指导图+配料）", beadgen.build_pdf(grid, used, counts),
                   file_name="拼豆图纸.pdf", mime="application/pdf")
