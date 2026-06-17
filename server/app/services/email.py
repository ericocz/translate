import logging
from typing import Protocol

import httpx

from app.core.config import settings

log = logging.getLogger("email")

RESEND_ENDPOINT = "https://api.resend.com/emails"


class EmailSender(Protocol):
    async def send(self, to: str, subject: str, body: str) -> None: ...


class LogEmailSender:
    """占位：码已落库，邮件失败不丢单；无 Resend 配置时用（dev / 联调）。"""

    async def send(self, to: str, subject: str, body: str) -> None:
        log.info("EMAIL → %s | %s | %s", to, subject, body)


class ResendEmailSender:
    """Resend HTTP API 驱动。发信失败抛异常，由调用方决定是否吞
    （买断 webhook 会吞掉——码已落库，可重投 / 手动补发）。"""

    def __init__(self, api_key: str, sender: str) -> None:
        self._key = api_key
        self._from = sender

    async def send(self, to: str, subject: str, body: str) -> None:
        # trust_env=False：与 DeepSeek 直连一致，绕开开发机本地 SOCKS 代理；香港部署直连境外 Resend。
        async with httpx.AsyncClient(trust_env=False, timeout=10.0) as client:
            resp = await client.post(
                RESEND_ENDPOINT,
                headers={"Authorization": f"Bearer {self._key}"},
                json={"from": self._from, "to": [to], "subject": subject, "text": body},
            )
            resp.raise_for_status()


def make_email_sender() -> EmailSender:
    """按配置选驱动：配了 Resend key + 发信地址用 Resend，否则退化为日志占位（不丢单）。"""
    if settings.resend_api_key and settings.email_from:
        return ResendEmailSender(settings.resend_api_key, settings.email_from)
    return LogEmailSender()
