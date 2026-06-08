from app.services.block_splitter import BlockSplitter


def collect(chunks: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    sp = BlockSplitter(lambda i, t: out.__setitem__(i, t))
    for c in chunks:
        sp.feed(c)
    sp.flush()
    return out


def test_basic_two_blocks():
    assert collect(["[[b1]] 你好\n[[b2]] 世界"]) == {"b1": "你好", "b2": "世界"}


def test_marker_split_across_chunks():
    # 模型把 [[b1]] 拆成多个 delta —— 必须在完整缓冲上重扫
    assert collect(["[", "[", "b", "1", "]", "]", " 你好"]) == {"b1": "你好"}


def test_dotted_id_from_spa_or_settle():
    # 沉降补抽 / SPA 新路由的 id 形如 r2.b30，正则字符类必须含 .
    assert collect(["[[r2.b30]] 译文"]) == {"r2.b30": "译文"}


def test_preamble_before_first_marker_discarded():
    assert collect(["前言垃圾[[b1]] 正文"]) == {"b1": "正文"}
