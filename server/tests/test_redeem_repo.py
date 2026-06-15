from app.db.base import async_session
from app.services.redeem_repo import RedeemCodeRepo, gen_code


def test_gen_code_shape():
    c = gen_code()
    # IMT-XXXX-XXXX-XXXX
    assert c.startswith("IMT-") and len(c) == 3 + 1 + 4 + 1 + 4 + 1 + 4
    parts = c.split("-")
    assert parts[0] == "IMT" and all(len(p) == 4 for p in parts[1:])


async def test_issue_idempotent_by_source_ref(db_session):
    async with async_session() as s:
        a = await RedeemCodeRepo(s).issue(email="u@x.com", source="creem", source_ref="ord_1")
    async with async_session() as s:
        b = await RedeemCodeRepo(s).issue(email="u@x.com", source="creem", source_ref="ord_1")
    assert a.code == b.code  # 同订单只一张


async def test_issue_distinct_orders(db_session):
    async with async_session() as s:
        repo = RedeemCodeRepo(s)
        a = await repo.issue(email="u@x.com", source="creem", source_ref="ord_1")
        b = await repo.issue(email="u@x.com", source="creem", source_ref="ord_2")
    assert a.code != b.code
    assert a.max_devices == 5 and a.product == "buyout"
    assert a.status == "active"  # Core insert 仍应套用列的客户端默认（不在 .values 里）
