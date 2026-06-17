from decimal import Decimal

from app.services.pricing import SERVICE_FEE_RATE, cost

# cost(input_miss_tokens, input_hit_tokens, output_tokens) -> 元 Decimal（高精度，不量化到分）


def test_three_tiers_with_30pct_fee():
    assert cost(1_000_000, 0, 0) == Decimal("1.30")    # 输入未命中 ¥1/M ×1.3
    assert cost(0, 1_000_000, 0) == Decimal("0.026")   # 输入命中 ¥0.02/M ×1.3（≈未命中 1/50）
    assert cost(0, 0, 1_000_000) == Decimal("2.60")    # 输出 ¥2/M ×1.3


def test_cache_hit_is_50x_cheaper_than_miss():
    assert cost(0, 1_000_000, 0) * 50 == cost(1_000_000, 0, 0)


def test_realistic_mixed_page_high_precision():
    # 4万未命中 + 1万命中 + 8万输出：(0.04 + 0.0002 + 0.16) ×1.3 = 0.26026 元（不丢精度）
    assert cost(40_000, 10_000, 80_000) == Decimal("0.26026")


def test_tiny_request_keeps_precision_not_zero():
    # 单句级别也按真实成本扣、不再四舍五入归零（方案 B：高精度账本、展示才 round）
    assert cost(1, 0, 1) == Decimal("0.0000039")


def test_zero_cost():
    assert cost(0, 0, 0) == Decimal("0")


def test_fee_rate_is_30pct():
    assert SERVICE_FEE_RATE == Decimal("1.3")
