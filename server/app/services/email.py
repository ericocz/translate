import logging
from typing import Protocol

log = logging.getLogger("email")


class EmailSender(Protocol):
    async def send(self, to: str, subject: str, body: str) -> None: ...


class LogEmailSender:
    """占位：码已落库，邮件失败不丢单；真实 Resend/阿里云驱动另计划。"""

    async def send(self, to: str, subject: str, body: str) -> None:
        log.info("EMAIL → %s | %s | %s", to, subject, body)
