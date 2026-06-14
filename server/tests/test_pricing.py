from app.services.pricing import cost_micro


def test_cost_micro_passthrough():
    assert cost_micro(1_000_000, 0) == 1_000_000   # ¥1 / 1M 输入
    assert cost_micro(0, 1_000_000) == 2_000_000   # ¥2 / 1M 输出
    assert cost_micro(40, 12) == 40 + 24
    assert cost_micro(0, 0) == 0
