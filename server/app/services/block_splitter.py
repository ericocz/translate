import re
from typing import Callable

# id 字符类必须含 `.`：沉降补抽 / SPA 新路由块 id 形如 r2.b30；漏 `.` 会让 [[r2.b30]]
# 整批匹配不上 → 该批译文无法切块回填、整页保持英文（历史踩坑）。
_MARKER = re.compile(r"\[\[([A-Za-z0-9_.\-]+)\]\]")


class BlockSplitter:
    """按 [[id]] 切块。

    流式难点：模型逐 token 返回，一个 [[id]] 标记常被拆散到多个小 chunk（如 "[["、"b"、
    "1"、"]]"）。绝不能在单个 chunk 内就地判定边界——必须把已到文本累积进 acc，每次在完整的
    acc 上重扫标记。acc 始终保留"最后一个已出现标记"及其之后的文本（这段可能还在增长）。
    """

    def __init__(self, on_block: Callable[[str, str], None]) -> None:
        self._acc = ""
        self._on_block = on_block

    def feed(self, chunk: str) -> None:
        """喂入一段流文本；识别出的完整块即时回调，缓冲在内部累积。"""
        self._acc += chunk
        self._process(False)

    def flush(self) -> None:
        """流结束时调用，确认并回调最后一块。"""
        self._process(True)

    def _process(self, flush_all: bool) -> None:
        marks = [(m.group(1), m.start(), m.end()) for m in _MARKER.finditer(self._acc)]
        if not marks:
            return
        # 非 flush 时，最后一个标记后的文本可能还没收完，留到下次 / flush 再确认。
        upto = len(marks) if flush_all else len(marks) - 1
        for i in range(upto):
            _id, _start, end = marks[i]
            text_end = marks[i + 1][1] if i + 1 < len(marks) else len(self._acc)
            self._on_block(_id, self._acc[end:text_end].strip())
        # 丢弃已确认部分；保留从最后一个标记起的尾巴（flush 后清空）。
        self._acc = "" if flush_all else self._acc[marks[-1][1]:]
