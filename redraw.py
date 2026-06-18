"""
AI 重画：照片 → 干净扁平卡通贴纸（去杂乱背景、突出特征），供拼豆管线使用。
用 OpenRouter 的 bytedance-seed/seedream-4.5（图生图）。
"""
import os
import io
import base64
import requests
from PIL import Image

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MODEL = "bytedance-seed/seedream-4.5"

# 默认重画提示词：扁平卡通贴纸、保特征、纯白底、少色、粗轮廓 —— 最适合拼豆
DEFAULT_PROMPT = (
    "Redraw this pet as a cute flat 2D cartoon sticker illustration. "
    "Keep the animal's breed, fur colors, markings and expression clearly recognizable. "
    "Use bold clean dark outlines, big clear eyes, a defined nose, and a few simplified "
    "flat color regions. No photographic texture, no gradients, no realistic shading. "
    "Plain solid pure white background, subject centered and fully visible. "
    "Chibi sticker style, suitable to be turned into pixel/perler bead art."
)


def _api_key(key=None):
    if key:
        return key
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    here = os.path.dirname(os.path.abspath(__file__))
    envp = os.path.join(here, ".env")
    if os.path.exists(envp):
        for line in open(envp):
            if line.startswith("OPENROUTER_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise RuntimeError("缺少 OPENROUTER_API_KEY（设环境变量或写入 .env）")


def _to_data_url(img, max_side=1024):
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return f"data:image/jpeg;base64,{b64}"


def redraw(img, prompt=None, api_key=None, timeout=180):
    """输入 PIL 图 → 返回重画后的 PIL 图。失败抛异常（含响应内容便于排查）。"""
    key = _api_key(api_key)
    payload = {
        "model": MODEL,
        "modalities": ["image"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt or DEFAULT_PROMPT},
                {"type": "image_url", "image_url": {"url": _to_data_url(img)}},
            ],
        }],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    r = requests.post(OPENROUTER_URL, json=payload, headers=headers, timeout=timeout)
    if r.status_code != 200:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:500]}")
    data = r.json()
    msg = data["choices"][0]["message"]
    images = msg.get("images") or []
    if not images:
        raise RuntimeError(f"响应无图片。message={str(msg)[:500]}")
    url = images[0]["image_url"]["url"]
    if url.startswith("data:"):
        b64 = url.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
    # 万一返回的是 http url
    resp = requests.get(url, timeout=timeout)
    return Image.open(io.BytesIO(resp.content)).convert("RGB")


if __name__ == "__main__":
    import sys
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else "redraw_out.png"
    res = redraw(Image.open(src))
    res.save(out)
    print("saved", out, res.size)
