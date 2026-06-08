from app.core.tokens import estimate_tokens


def test_empty_is_zero():
    assert estimate_tokens("") == 0


def test_english_roughly_quarter_chars():
    # 纯 ASCII 约 chars/4，给一个宽松区间即可
    n = estimate_tokens("a" * 40)
    assert 8 <= n <= 12


def test_cjk_counts_more_than_english_same_len():
    assert estimate_tokens("你好世界") > estimate_tokens("abcd")


def test_monotonic():
    assert estimate_tokens("hello world foo") > estimate_tokens("hello")
