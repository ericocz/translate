from app.services.pricing import SERVICE_FEE_RATE, cost_micro


def test_includes_30pct_service_fee():
    # 成本价 ¥1/M 输入、¥2/M 输出，统一 ×1.3 服务费
    assert cost_micro(1_000_000, 0) == 1_300_000   # 1M 输入：成本 1M ×1.3
    assert cost_micro(0, 1_000_000) == 2_600_000   # 1M 输出：成本 2M ×1.3
    assert cost_micro(1_000, 1_000) == 3_900        # 成本 3000 ×1.3


def test_rounds_to_int():
    # 成本 = 1*1 + 1*2 = 3；×1.3 = 3.9 → 4
    assert cost_micro(1, 1) == 4


def test_zero_cost():
    assert cost_micro(0, 0) == 0


def test_fee_rate_is_30pct():
    assert SERVICE_FEE_RATE == 1.3
