"""
AI 重画：照片 → 干净扁平卡通贴纸（去杂乱背景、突出特征），供拼豆管线使用。
支持两个图生图后端，用环境变量 REDRAW_BACKEND 切换：
  - openrouter（默认）: OpenRouter 的 bytedance-seed/seedream-4.5
  - volcano          : 火山方舟 Ark 的 doubao-seedream（如 seedream-5.0-lite）
"""
import os
import io
import base64
import requests
from PIL import Image

# 默认重画提示词：扁平卡通贴纸、保特征、纯白底、少色、粗轮廓 —— 最适合拼豆
DEFAULT_PROMPT = (
    "Redraw this pet as a cute flat 2D cartoon sticker illustration. "
    "Keep the animal's breed, fur colors, markings and expression clearly recognizable. "
    "Use bold clean dark outlines, big clear eyes, a defined nose, and a few simplified "
    "flat color regions. No photographic texture, no gradients, no realistic shading. "
    "Plain solid pure white background, subject centered and fully visible. "
    "Chibi sticker style, suitable to be turned into pixel/perler bead art."
)

# 后端配置：env 名、默认 endpoint、默认模型
_BACKENDS = {
    "openrouter": {
        "key_env": "OPENROUTER_API_KEY",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": "bytedance-seed/seedream-4.5",
    },
    "volcano": {
        "key_env": "ARK_API_KEY",
        "url": "https://ark.cn-beijing.volces.com/api/v3/images/generations",
        "model": "doubao-seedream-4-0-250828",  # 切 5.0 lite 时改这里或设 REDRAW_MODEL
    },
}


def current_backend():
    return os.environ.get("REDRAW_BACKEND", "openrouter").lower()


def key_env_name(backend=None):
    return _BACKENDS[backend or current_backend()]["key_env"]


def _api_key(backend=None, key=None):
    if key:
        return key
    name = key_env_name(backend)
    if os.environ.get(name):
        return os.environ[name]
    envp = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(envp):
        for line in open(envp):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError(f"缺少 {name}（设环境变量或写入 .env）")


def _to_data_url(img, max_side=1024):
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _img_from_url_or_b64(url, timeout):
    if url.startswith("data:"):
        return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")
    return Image.open(io.BytesIO(requests.get(url, timeout=timeout).content)).convert("RGB")


def _redraw_openrouter(img, prompt, key, model, timeout):
    payload = {
        "model": model, "modalities": ["image"],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": _to_data_url(img)}},
        ]}],
    }
    r = requests.post(_BACKENDS["openrouter"]["url"], json=payload, timeout=timeout,
                      headers={"Authorization": f"Bearer {key}",
                               "Content-Type": "application/json"})
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
    imgs = r.json()["choices"][0]["message"].get("images") or []
    if not imgs:
        raise RuntimeError("OpenRouter 响应无图片")
    return _img_from_url_or_b64(imgs[0]["image_url"]["url"], timeout)


def _redraw_volcano(img, prompt, key, model, timeout):
    payload = {
        "model": model, "prompt": prompt, "image": _to_data_url(img),
        "response_format": "b64_json", "size": "2K", "watermark": False,
    }
    r = requests.post(_BACKENDS["volcano"]["url"], json=payload, timeout=timeout,
                      headers={"Authorization": f"Bearer {key}",
                               "Content-Type": "application/json"})
    if r.status_code != 200:
        raise RuntimeError(f"火山方舟 {r.status_code}: {r.text[:500]}")
    data = r.json().get("data") or []
    if not data:
        raise RuntimeError(f"火山方舟响应无图片: {str(r.json())[:300]}")
    item = data[0]
    if item.get("b64_json"):
        return Image.open(io.BytesIO(base64.b64decode(item["b64_json"]))).convert("RGB")
    return _img_from_url_or_b64(item["url"], timeout)


def redraw(img, prompt=None, api_key=None, backend=None, model=None, timeout=180):
    """输入 PIL 图 → 返回重画后的 PIL 图。backend 默认读 env REDRAW_BACKEND。"""
    backend = (backend or current_backend()).lower()
    if backend not in _BACKENDS:
        raise RuntimeError(f"未知后端 {backend}，可选: {list(_BACKENDS)}")
    key = _api_key(backend, api_key)
    model = model or os.environ.get("REDRAW_MODEL") or _BACKENDS[backend]["model"]
    prompt = prompt or DEFAULT_PROMPT
    fn = _redraw_openrouter if backend == "openrouter" else _redraw_volcano
    return fn(img, prompt, key, model, timeout)


if __name__ == "__main__":
    import sys
    res = redraw(Image.open(sys.argv[1]))
    out = sys.argv[2] if len(sys.argv) > 2 else "redraw_out.png"
    res.save(out)
    print("saved", out, res.size, "| backend:", current_backend())
