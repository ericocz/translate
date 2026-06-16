from app.core.ratelimit import Rule, SlidingWindowCounter, classify, client_ip


def test_allow_within_window_then_block():
    lim = SlidingWindowCounter()
    rule = Rule(3, 60)
    assert [lim.allow("k", rule, now=t) for t in (0, 1, 2)] == [True, True, True]
    assert lim.allow("k", rule, now=3) is False  # 同窗口第 4 次超限


def test_sliding_blocks_boundary_burst():
    # 固定窗口的「边界 2×limit 突刺」在滑动窗口下应被挡住
    lim = SlidingWindowCounter()
    rule = Rule(3, 60)
    for t in (50, 55, 59):  # 窗口 [0,60) 发满 3
        assert lim.allow("k", rule, now=t) is True
    # 刚跨入窗口 [60,120) 开头：上窗口权重≈1、估算≈3 → 拒（固定窗口这里会放行＝突刺）
    assert lim.allow("k", rule, now=60) is False


def test_prev_window_decays_over_time():
    lim = SlidingWindowCounter()
    rule = Rule(4, 60)
    for t in (0, 1, 2, 3):  # 窗口 [0,60) 发满 4
        lim.allow("k", rule, now=t)
    # 进入窗口 [60,120) 过半（now=90）：上窗口权重 0.5 → est=4×0.5=2 <4 → 放行
    assert lim.allow("k", rule, now=90) is True


def test_old_window_fully_expired():
    lim = SlidingWindowCounter()
    rule = Rule(2, 60)
    lim.allow("k", rule, now=0)
    lim.allow("k", rule, now=1)  # 窗口 [0,60) 满 2
    # 隔到窗口 [120,180)（now=130）：旧窗口数据全失效 → 放行
    assert lim.allow("k", rule, now=130) is True


def test_keys_independent():
    lim = SlidingWindowCounter()
    rule = Rule(1, 60)
    assert lim.allow("a", rule, now=0) is True
    assert lim.allow("b", rule, now=0) is True  # 不同 IP / 路径互不影响


def test_classify_high_threshold_ddos_gate():
    assert classify("/v1/auth/login").limit == 120   # 撞库 IP 兜底
    assert classify("/v1/translate").limit == 600     # DDoS 闸（额度管细粒度）
    assert classify("/v1/grant/gift").limit == 600     # 网吧每台合法领、不低阈值
    assert classify("/v1/usage").limit == 600
    # 不限流的：
    assert classify("/health") is None
    assert classify("/v1/billing/creem/webhook") is None
    assert classify("/admin/users") is None


def test_client_ip_prefers_forwarded():
    assert client_ip("1.2.3.4, 5.6.7.8", "9.9.9.9") == "1.2.3.4"
    assert client_ip(None, "9.9.9.9") == "9.9.9.9"
    assert client_ip(None, None) == "unknown"
