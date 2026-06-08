import re
from dataclasses import dataclass

# 唯一标记词法：< (前导 /?) (g|x) (数字) (后随 /?) >
_MARKER_RE = re.compile(r"<(/?)([gx])(\d+)(/?)>")
# 形似标记但夹空格 / 大小写不规范（模型偶发）——兜底拒绝，避免半成品漏到页面。
_LOOSE_RE = re.compile(r"<\s*/?\s*[gx]\s*\d+\s*/?\s*>", re.IGNORECASE)


@dataclass
class _Tok:
    kind: str  # text | open | close | void
    n: int = -1
    text: str = ""


def _tokenize(s: str) -> list[_Tok] | None:
    """切成 token 序列；任一标记落在四种合法形态之外即整块非法 → None。"""
    tokens: list[_Tok] = []
    last = 0
    for m in _MARKER_RE.finditer(s):
        if m.start() > last:
            tokens.append(_Tok("text", text=s[last:m.start()]))
        lead, kind, num, trail = m.group(1), m.group(2), m.group(3), m.group(4)
        n = int(num)
        if kind == "g" and lead == "" and trail == "":
            tokens.append(_Tok("open", n))
        elif kind == "g" and lead == "/" and trail == "":
            tokens.append(_Tok("close", n))
        elif kind == "x" and lead == "" and trail == "/":
            tokens.append(_Tok("void", n))
        else:
            return None  # <gN/> / <xN> / </xN> 等畸形组合
        last = m.end()
    if last < len(s):
        tokens.append(_Tok("text", text=s[last:]))
    # 残留"形似标记"的文本说明模型把标记写坏了（如 < g0 >）——拒绝。
    for t in tokens:
        if t.kind == "text" and _LOOSE_RE.search(t.text):
            return None
    return tokens


@dataclass
class ValidateResult:
    ok: bool
    reason: str = ""


def validate_markers(translated: str, allowed_ids: set[int]) -> ValidateResult:
    """校验译文标记：词法合法 + 成对标记严格 LIFO（可移动/嵌套，不得交叉/提前闭合）
    + 编号都在 allowed_ids 内 + 自闭合标记不重复。不强求 allowed_ids 全部出现。"""
    tokens = _tokenize(translated)
    if tokens is None:
        return ValidateResult(False, "标记词法非法")
    stack: list[int] = []
    void_seen: set[int] = set()
    for t in tokens:
        if t.kind == "text":
            continue
        if t.n not in allowed_ids:
            return ValidateResult(False, f"未知标记编号 {t.n}")
        if t.kind == "open":
            stack.append(t.n)
        elif t.kind == "close":
            top = stack.pop() if stack else None
            if top != t.n:
                return ValidateResult(False, f"成对标记交叉或未匹配 g{t.n}")
        else:  # void
            if t.n in void_seen:
                return ValidateResult(False, f"自闭合标记 x{t.n} 重复")
            void_seen.add(t.n)
    if stack:
        return ValidateResult(False, "未关闭的成对标记")
    return ValidateResult(True)


def allowed_ids_from_source(source: str) -> set[int]:
    """从 source 反推出现过的标记编号（服务端无 styleMap，据此做与客户端等价的校验，只缓存合法译文）。"""
    return {int(m.group(3)) for m in _MARKER_RE.finditer(source)}


def is_verbatim_echo(source: str, translated: str) -> bool:
    """译文是否只把 source 原样照抄（空翻译）：归一化空白后逐字相同。
    这类"空翻译"绝不入缓存，否则会永久命中英文（缓存污染）。"""
    norm = lambda x: re.sub(r"\s+", " ", x).strip()
    return norm(source) == norm(translated)
