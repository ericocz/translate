from app.services.tier import (
    CAPS,
    RECOVER_THRESHOLD,
    TierState,
    evaluate_tier,
)


def test_first_request_allowed_tier0():
    ev = evaluate_tier(TierState(0, 0, 0, None), "2026-06-08", tokens_today=0, prev_day_tokens=0)
    assert ev.allowed and ev.cap == CAPS[0] and ev.state.last_day == "2026-06-08"


def test_over_cap_blocks_with_notice():
    ev = evaluate_tier(
        TierState(0, 0, 0, "2026-06-08"), "2026-06-08", tokens_today=CAPS[0], prev_day_tokens=0
    )
    assert not ev.allowed and ev.notice


def test_consecutive_capped_days_downgrade():
    e1 = evaluate_tier(
        TierState(0, 0, 0, "2026-06-08"), "2026-06-09", tokens_today=0, prev_day_tokens=CAPS[0]
    )
    assert e1.state.tier == 0 and e1.state.strikes == 1
    e2 = evaluate_tier(e1.state, "2026-06-10", tokens_today=0, prev_day_tokens=CAPS[0])
    assert e2.state.tier == 1 and e2.cap == CAPS[1] and e2.notice


def test_consecutive_clean_days_upgrade():
    cur = TierState(1, 0, 0, "2026-06-08")
    day = 9
    for _ in range(RECOVER_THRESHOLD):
        cur = evaluate_tier(cur, f"2026-06-{day:02d}", tokens_today=0, prev_day_tokens=0).state
        day += 1
    assert cur.tier == 0


def test_same_day_repeated_no_extra_strike():
    e = evaluate_tier(
        TierState(0, 0, 0, "2026-06-08"), "2026-06-08", tokens_today=CAPS[0] + 100, prev_day_tokens=0
    )
    assert not e.allowed and e.state.strikes == 0  # 同日不累计 strike（跨日才结算）
