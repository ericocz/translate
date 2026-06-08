import hashlib

from app.core.prompt import SYSTEM_PROMPT

MODEL = "deepseek-v4-flash"


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


# 版本前缀：模型 / 提示词任一变化 → 前缀变化 → 旧缓存自动失效（绝不返回过期译文）。
VERSION = _sha(MODEL + " " + SYSTEM_PROMPT)[:12]


def key_of(source: str) -> str:
    """内容寻址缓存键：版本 + source 哈希。"""
    return f"{VERSION}:{_sha(source)[:16]}"
