from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_admin_token, decode_admin_token, verify_password
from app.db.base import async_session
from app.db.models import (
    Admin,
    CreditTxn,
    DailyUsage,
    ErrorLog,
    Event,
    UpstreamKey,
    User,
)
from app.services.credit_repo import CreditRepo, user_owner

router = APIRouter(prefix="/admin")


async def get_session() -> AsyncIterator[AsyncSession]:
    async with async_session() as s:
        yield s


def admin_required(request: Request) -> int:
    auth = request.headers.get("authorization", "")
    admin_id = decode_admin_token(auth[7:].strip()) if auth.lower().startswith("bearer ") else None
    if admin_id is None:
        raise HTTPException(status_code=401, detail="需要管理员登录")
    return admin_id


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/login")
async def admin_login(body: LoginIn, session: AsyncSession = Depends(get_session)):
    admin = await session.scalar(select(Admin).where(Admin.email == body.email.strip().lower()))
    if admin is None or not verify_password(body.password, admin.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    return {"token": create_admin_token(admin.id), "email": admin.email}


@router.get("/stats")
async def stats(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    users = await session.scalar(select(func.count()).select_from(User)) or 0
    translations = (
        await session.scalar(
            select(func.count()).select_from(Event).where(Event.type == "translate_done")
        )
        or 0
    )
    errors = await session.scalar(select(func.count()).select_from(ErrorLog)) or 0
    tokens = (
        await session.scalar(
            select(func.coalesce(func.sum(DailyUsage.input_tokens + DailyUsage.output_tokens), 0))
        )
        or 0
    )
    top_rows = (
        await session.execute(
            select(Event.host, func.count().label("n"))
            .where(Event.host.is_not(None))
            .group_by(Event.host)
            .order_by(func.count().desc())
            .limit(10)
        )
    ).all()
    return {
        "users": int(users),
        "translations": int(translations),
        "errors": int(errors),
        "tokens": int(tokens),
        "topHosts": [{"host": h, "count": int(n)} for h, n in top_rows],
    }


@router.get("/users")
async def users(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    today = date.today().isoformat()
    rows = (await session.execute(select(User).order_by(User.id.desc()).limit(200))).scalars().all()
    ids = [u.id for u in rows]
    # 批量取当日用量与额度余额（按 user_id 归集），避免逐用户 N+1 查询。
    usage_by_user: dict[int, DailyUsage] = {}
    balance_by_user: dict[int, int] = {}
    if ids:
        usage_rows = (
            await session.execute(
                select(DailyUsage).where(
                    DailyUsage.user_id.in_(ids), DailyUsage.local_date == today
                )
            )
        ).scalars()
        usage_by_user = {du.user_id: du for du in usage_rows}
        owner_to_id = {f"u:{i}": i for i in ids}
        # 余额＝账本流水加总（方案 B）：按 owner 聚合 SUM(delta)。
        bal_rows = await session.execute(
            select(CreditTxn.owner, func.sum(CreditTxn.delta))
            .where(CreditTxn.owner.in_(list(owner_to_id)))
            .group_by(CreditTxn.owner)
        )
        balance_by_user = {owner_to_id[owner]: total for owner, total in bal_rows}
    out = []
    for u in rows:
        du = usage_by_user.get(u.id)
        out.append({
            "id": u.id,
            "email": u.email,
            "tokensToday": int((du.input_tokens + du.output_tokens) if du else 0),
            "balance": float(balance_by_user.get(u.id, 0)),  # 元
            "createdAt": u.created_at.isoformat() if u.created_at else None,
        })
    return out


@router.get("/errors")
async def errors(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (
        await session.execute(select(ErrorLog).order_by(ErrorLog.id.desc()).limit(200))
    ).scalars().all()
    return [
        {
            "id": r.id,
            "ts": r.ts.isoformat(),
            "kind": r.kind,
            "message": r.message,
            "context": r.context,
            "userId": r.user_id,
        }
        for r in rows
    ]


@router.get("/events")
async def events(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (
        await session.execute(select(Event).order_by(Event.id.desc()).limit(200))
    ).scalars().all()
    return [
        {"id": r.id, "ts": r.ts.isoformat(), "type": r.type, "host": r.host, "props": r.props}
        for r in rows
    ]


# ---- 上游 Key 管理（脱敏：绝不回完整 Key）----
def _mask(v: str) -> str:
    return ("•" * max(0, len(v) - 4)) + v[-4:] if v else ""


def _key_out(k: UpstreamKey) -> dict:
    return {
        "id": k.id,
        "label": k.label,
        "masked": _mask(k.key_value),
        "status": k.status,
        "usedTokens": k.used_tokens,
        "balanceNote": k.balance_note,
    }


class KeyIn(BaseModel):
    label: str
    key: str


class KeyPatch(BaseModel):
    status: str


@router.get("/keys")
async def list_keys(session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)):
    rows = (await session.execute(select(UpstreamKey).order_by(UpstreamKey.id))).scalars().all()
    return [_key_out(k) for k in rows]


@router.post("/keys")
async def add_key(
    body: KeyIn, session: AsyncSession = Depends(get_session), _: int = Depends(admin_required)
):
    k = UpstreamKey(label=body.label, key_value=body.key)
    session.add(k)
    await session.commit()
    await session.refresh(k)
    return _key_out(k)


@router.patch("/keys/{key_id}")
async def patch_key(
    key_id: int,
    body: KeyPatch,
    session: AsyncSession = Depends(get_session),
    _: int = Depends(admin_required),
):
    k = await session.get(UpstreamKey, key_id)
    if k is None:
        raise HTTPException(status_code=404, detail="not found")
    k.status = body.status
    await session.commit()
    return _key_out(k)


# ---- 手动调额度（客服补单 / 退款纠正）----
class CreditAdjustIn(BaseModel):
    userId: int | None = None  # 注册用户 → owner=u:{userId}
    owner: str | None = None   # 直接指定 owner（u:{id} | d:{deviceId}），与 userId 二选一
    amount: Decimal            # 元，正=补发/赠送，负=扣回/纠正
    note: str | None = None    # 备注（留痕，记入流水 kind 之外暂不落库）
    ref: str | None = None     # 提供则作幂等键 admin:{ref}，防重复提交双发


@router.post("/credits/grant")
async def admin_grant_credits(
    body: CreditAdjustIn,
    session: AsyncSession = Depends(get_session),
    _: int = Depends(admin_required),
):
    """手动给某 owner 调额度（元）：正数补发、负数扣回。
    幂等：带 ref 时同一 ref 重复提交只入账一次（防误点双发）。"""
    owner = body.owner or (user_owner(body.userId) if body.userId is not None else None)
    if not owner:
        raise HTTPException(status_code=400, detail="需指定 userId 或 owner")
    amount = body.amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount == 0:
        raise HTTPException(status_code=400, detail="amount 不能为 0")
    kind = "refund" if amount < 0 else "admin_grant"
    idem = f"admin:{body.ref}" if body.ref else None
    balance = await CreditRepo(session).grant(owner, amount, kind=kind, idempotency_key=idem)
    return {"ok": True, "owner": owner, "amount": float(amount), "balance": float(balance)}
