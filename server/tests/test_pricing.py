from decimal import Decimal

from app.services.pricing import SERVICE_FEE_RATE, cost, cost_cny, cost_for, cost_usd

# cost_cny / cost_usd(input_miss, input_hit, output) -> 币种原生单位 Decimal（高精度，不量化）


def test_three_tiers_with_30pct_fee():
    assert cost_cny(1_000_000, 0, 0) == Decimal("1.30")    # 输入未命中 ¥1/M ×1.3
    assert cost_cny(0, 1_000_000, 0) == Decimal("0.026")   # 输入命中 ¥0.02/M ×1.3（≈未命中 1/50）
    assert cost_cny(0, 0, 1_000_000) == Decimal("2.60")    # 输出 ¥2/M ×1.3


def test_usd_three_tiers_with_30pct_fee():
    assert cost_usd(1_000_000, 0, 0) == Decimal("0.182")     # $0.14/M ×1.3
    assert cost_usd(0, 1_000_000, 0) == Decimal("0.00364")   # $0.0028/M ×1.3
    assert cost_usd(0, 0, 1_000_000) == Decimal("0.364")     # $0.28/M ×1.3


def test_usd_cache_hit_is_50x_cheaper_than_miss():
    assert cost_usd(0, 1_000_000, 0) * 50 == cost_usd(1_000_000, 0, 0)


def test_cost_for_picks_currency():
    assert cost_for("USD", 1_000_000, 0, 0) == cost_usd(1_000_000, 0, 0)
    assert cost_for("CNY", 1_000_000, 0, 0) == cost_cny(1_000_000, 0, 0)
    assert cost_for("CNY", 0, 0, 1) == cost(0, 0, 1)  # 默认别名＝人民币


def test_cache_hit_is_50x_cheaper_than_miss():
    assert cost_cny(0, 1_000_000, 0) * 50 == cost_cny(1_000_000, 0, 0)


def test_realistic_mixed_page_high_precision():
    # 4万未命中 + 1万命中 + 8万输出：(0.04 + 0.0002 + 0.16) ×1.3 = 0.26026 元（不丢精度）
    assert cost_cny(40_000, 10_000, 80_000) == Decimal("0.26026")


def test_tiny_request_keeps_precision_not_zero():
    # 单句级别也按真实成本扣、不再四舍五入归零（方案 B：高精度账本、展示才 round）
    assert cost_cny(1, 0, 1) == Decimal("0.0000039")


def test_zero_cost():
    assert cost_cny(0, 0, 0) == Decimal("0")
    assert cost_usd(0, 0, 0) == Decimal("0")


def test_fee_rate_is_30pct():
    assert SERVICE_FEE_RATE == Decimal("1.3")
