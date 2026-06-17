import json

import httpx
import pytest

from app.core.config import settings
from app.services.email import (
    RESEND_ENDPOINT,
    LogEmailSender,
    ResendEmailSender,
    make_email_sender,
)


def _mock_httpx(monkeypatch, handler):
    """把 httpx.AsyncClient 换成走 MockTransport 的，捕获请求（吞掉 trust_env/timeout 等 kw）。"""
    real = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=transport))


async def test_resend_sends_correct_request(monkeypatch):
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["auth"] = req.headers.get("authorization")
        captured["body"] = json.loads(req.content)
        return httpx.Response(200, json={"id": "email_abc"})

    _mock_httpx(monkeypatch, handler)
    await ResendEmailSender("re_k", "秒懂翻译 <noreply@aha.test>").send(
        "user@x.com", "你的注册码", "码：IMT-AAAA-BBBB-CCCC"
    )
    assert captured["url"] == RESEND_ENDPOINT
    assert captured["auth"] == "Bearer re_k"
    assert captured["body"] == {
        "from": "秒懂翻译 <noreply@aha.test>",
        "to": ["user@x.com"],
        "subject": "你的注册码",
        "text": "码：IMT-AAAA-BBBB-CCCC",
    }


async def test_resend_raises_on_http_error(monkeypatch):
    _mock_httpx(monkeypatch, lambda req: httpx.Response(422, json={"error": "bad domain"}))
    with pytest.raises(httpx.HTTPStatusError):
        await ResendEmailSender("re_k", "a@b.c").send("u@x.com", "s", "b")


def test_factory_picks_resend_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "resend_api_key", "re_k")
    monkeypatch.setattr(settings, "email_from", "秒懂翻译 <n@aha.test>")
    assert isinstance(make_email_sender(), ResendEmailSender)


def test_factory_falls_back_to_log_without_config(monkeypatch):
    monkeypatch.setattr(settings, "resend_api_key", "")
    monkeypatch.setattr(settings, "email_from", "")
    assert isinstance(make_email_sender(), LogEmailSender)
