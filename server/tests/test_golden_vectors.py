"""金标向量双端对齐：与前端 front/test-vectors/local-engine.json 共读同一组 fixture，
断言后端 estimate_tokens / BlockSplitter 与前端 TS 实现逐值一致。

BYOK 把翻译协议（token 估算、[[id]] 切块）变成「Python 一份、TS 一份」，本测试是防漂移闸：
改任一端的协议逻辑、未同步更新另一端与本 JSON，本测试或前端 .test-local-engine.mjs 必失败。
"""

import json
from pathlib import Path

import pytest

from app.core.tokens import estimate_tokens
from app.services.block_splitter import BlockSplitter

_VECTORS_PATH = Path(__file__).resolve().parents[2] / "front" / "test-vectors" / "local-engine.json"
_VECTORS = json.loads(_VECTORS_PATH.read_text(encoding="utf-8"))


def _split(chunks: list[str]) -> list[list[str]]:
    out: list[list[str]] = []
    bs = BlockSplitter(lambda i, t: out.append([i, t]))
    for c in chunks:
        bs.feed(c)
    bs.flush()
    return out


@pytest.mark.parametrize("case", _VECTORS["tokens"], ids=lambda c: repr(c["text"])[:24])
def test_estimate_tokens_matches_golden(case):
    assert estimate_tokens(case["text"]) == case["expected"]


@pytest.mark.parametrize("case", _VECTORS["blockSplit"], ids=lambda c: c["name"])
def test_block_split_matches_golden(case):
    assert _split(case["chunks"]) == case["expected"]
