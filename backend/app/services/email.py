"""Transactional email. `console` logs the message (dev), `memory` captures it (tests),
`smtp` sends via STARTTLS."""

from __future__ import annotations

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

from app.config import get_settings

log = logging.getLogger(__name__)


@dataclass
class SentEmail:
    to: str
    subject: str
    body: str


OUTBOX: list[SentEmail] = []


def send_email(to: str, subject: str, body: str) -> None:
    s = get_settings()
    if s.email_backend == "memory":
        OUTBOX.append(SentEmail(to, subject, body))
        return
    if s.email_backend == "console":
        # Dev only: the body contains single-use links, so never use this in production.
        log.info("email.console", extra={"to": to, "subject": subject, "body": body})
        print(f"\n--- EMAIL to {to}: {subject}\n{body}\n---\n", flush=True)  # noqa: T201
        return
    msg = EmailMessage()
    msg["From"] = s.smtp_from
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(s.smtp_host or "localhost", s.smtp_port, timeout=15) as smtp:  # pragma: no cover
        if s.smtp_starttls:
            smtp.starttls()
        if s.smtp_username:
            smtp.login(s.smtp_username, s.smtp_password or "")
        smtp.send_message(msg)


def send_verification(to: str, token: str) -> None:
    url = f"{get_settings().public_base_url}/verify-email?token={token}"
    send_email(to, "Verify your email", f"Confirm your email address by opening:\n\n{url}\n\nThis link expires in 24 hours.")


def send_password_reset(to: str, token: str) -> None:
    url = f"{get_settings().public_base_url}/reset-password?token={token}"
    send_email(
        to,
        "Reset your password",
        f"A password reset was requested for this account. Open the link below to choose a new password:\n\n{url}\n\n"
        "This link expires in 1 hour. If you did not request this, you can ignore this email.",
    )
