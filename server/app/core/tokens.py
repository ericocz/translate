import math
import re

# CJK 基本/扩展 A、兼容表意文字、扩展 B。用于把中文字符与 ASCII 区别对待。
_CJK = re.compile(r"[㐀-鿿豈-﫿\U00020000-\U0002ffff]")


def estimate_tokens(text: str) -> int:
    """轻量本地 token 估算：CJK 字符按 ~0.6 token/字，其余 ASCII/符号按 ~4 char/token。

    用于给缓存条目记 token（缓存命中归因），无需与上游 tokenizer 精确一致——
    未命中时用量以 DeepSeek 接口返回的真实 usage 为准（见 translator）。
    """
    if not text:
        return 0
    cjk = len(_CJK.findall(text))
    other = len(text) - cjk
    return math.ceil(cjk * 0.6 + other / 4)
