import pytest

from app.services.auth import AuthError, AuthService


async def test_register_then_login(db_session):
    svc = AuthService(db_session)
    reg = await svc.register("a@b.com", "pw12345")
    assert reg.email == "a@b.com" and reg.access and reg.refresh
    log = await svc.login("a@b.com", "pw12345")
    assert log.user_id == reg.user_id


async def test_register_duplicate_email_rejected(db_session):
    svc = AuthService(db_session)
    await svc.register("a@b.com", "pw12345")
    with pytest.raises(AuthError):
        await svc.register("a@b.com", "other123")


async def test_login_wrong_password_rejected(db_session):
    svc = AuthService(db_session)
    await svc.register("a@b.com", "pw12345")
    with pytest.raises(AuthError):
        await svc.login("a@b.com", "nope")


async def test_refresh_issues_new_access(db_session):
    svc = AuthService(db_session)
    reg = await svc.register("a@b.com", "pw12345")
    out = await svc.refresh(reg.refresh)
    assert out.access and out.user_id == reg.user_id


async def test_logout_invalidates_refresh(db_session):
    svc = AuthService(db_session)
    reg = await svc.register("a@b.com", "pw12345")
    await svc.logout(reg.refresh)
    with pytest.raises(AuthError):
        await svc.refresh(reg.refresh)
