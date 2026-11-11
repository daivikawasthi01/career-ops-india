"""
Gmail drafts, and nothing else. The app signs in once (OAuth for a desktop app, the redirect comes back to this server on 127.0.0.1),
then creates a draft with attachments in your own account. It never sends, reads or lists mail: the only Gmail call is drafts.create,
under the gmail.compose scope. You open the draft in Gmail and press Send yourself.

Setup: data/gmail-credentials.json (the OAuth client JSON from Google Cloud, type "Desktop app"). The tokens are kept in
data/gmail-token.json, readable by you only. Both files are gitignored.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage
from typing import Callable

from . import config

SCOPE = "https://www.googleapis.com/auth/gmail.compose"
DRAFTS = "https://gmail.googleapis.com/gmail/v1/users/me/drafts"
MAX_ATTACH = 20 * 1024 * 1024
CRED = config.ROOT / "data" / "gmail-credentials.json"
TOKEN = config.ROOT / "data" / "gmail-token.json"


class GmailError(ValueError):
    """Something the user can act on (sign in again, add the credentials file); the message is shown as is."""


def _http(method: str, url: str, headers: dict, data: bytes | None, timeout: float = 30) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except (OSError, ValueError) as e:
        raise GmailError(f"Could not reach Google: {e}") from e


http: Callable[..., tuple[int, dict]] = _http     # the outside-world seam; tests replace it
_PENDING: dict[str, str] = {}                     # sign-in state -> PKCE verifier, used once


def _client() -> dict:
    try:
        raw = json.loads(CRED.read_text())
    except (OSError, ValueError) as e:
        raise GmailError("Gmail is not set up: save the OAuth client JSON as data/gmail-credentials.json.") from e
    c = raw.get("installed") or raw.get("web") or {}
    if not c.get("client_id") or not c.get("client_secret"):
        raise GmailError("data/gmail-credentials.json has no client_id and client_secret.")
    return c


def _tokens() -> dict:
    try:
        return json.loads(TOKEN.read_text())
    except (OSError, ValueError):
        return {}


def _save(tok: dict) -> None:
    tmp = TOKEN.with_suffix(".tmp")
    tmp.write_text(json.dumps(tok))
    os.chmod(tmp, 0o600)
    tmp.replace(TOKEN)


def status() -> dict:
    return {"configured": CRED.exists(), "connected": bool(_tokens().get("refresh_token"))}


def disconnect() -> None:
    TOKEN.unlink(missing_ok=True)


def redirect_uri() -> str:
    return f"http://127.0.0.1:{config.load()['server']['port']}/gmail/callback"


def start() -> str:
    """The Google sign-in address to open in a browser tab."""
    c = _client()
    state, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(64)
    _PENDING[state] = verifier
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    q = {"client_id": c["client_id"], "redirect_uri": redirect_uri(), "response_type": "code", "scope": SCOPE, "state": state,
         "code_challenge": challenge, "code_challenge_method": "S256", "access_type": "offline", "prompt": "consent"}
    return c.get("auth_uri", "https://accounts.google.com/o/oauth2/v2/auth") + "?" + urllib.parse.urlencode(q)


def finish(state: str, code: str) -> None:
    """Trade the sign-in code for tokens. An unknown or reused state is refused."""
    verifier = _PENDING.pop(state, None)
    if not verifier:
        raise GmailError("This sign-in link is not one this app started. Press Connect Gmail again.")
    c = _client()
    status_code, out = http("POST", c.get("token_uri", "https://oauth2.googleapis.com/token"), {"Content-Type": "application/x-www-form-urlencoded"},
                            urllib.parse.urlencode({"code": code, "client_id": c["client_id"], "client_secret": c["client_secret"], "redirect_uri": redirect_uri(),
                                                    "grant_type": "authorization_code", "code_verifier": verifier}).encode())
    if status_code != 200 or not out.get("refresh_token"):
        raise GmailError(f"Google did not accept the sign-in ({out.get('error_description') or out.get('error') or status_code}).")
    _save({"refresh_token": out["refresh_token"], "access_token": out.get("access_token", ""), "expires_at": time.time() + int(out.get("expires_in", 0)) - 60})


def _access() -> str:
    tok = _tokens()
    if not tok.get("refresh_token"):
        raise GmailError("Gmail is not connected. Press Connect Gmail.")
    if tok.get("access_token") and tok.get("expires_at", 0) > time.time():
        return tok["access_token"]
    c = _client()
    code, out = http("POST", c.get("token_uri", "https://oauth2.googleapis.com/token"), {"Content-Type": "application/x-www-form-urlencoded"},
                     urllib.parse.urlencode({"client_id": c["client_id"], "client_secret": c["client_secret"], "refresh_token": tok["refresh_token"],
                                             "grant_type": "refresh_token"}).encode())
    if code != 200 or not out.get("access_token"):
        if out.get("error") == "invalid_grant":
            disconnect()  # expired or revoked (an app left in Testing loses its tokens after 7 days)
            raise GmailError("Google asked for a new sign-in. Press Connect Gmail again.")
        raise GmailError(f"Google refused to refresh the sign-in ({out.get('error') or code}).")
    _save({**tok, "access_token": out["access_token"], "expires_at": time.time() + int(out.get("expires_in", 3600)) - 60})
    return out["access_token"]


def create_draft(to: str, subject: str, body: str, attachments: list[tuple[str, bytes, str]] | None = None) -> dict:
    """A draft in your Gmail with the attachments (filename, bytes, mime type) on it. Returns {draft_id, message_id, url}. Never sends."""
    attachments = attachments or []
    if sum(len(b) for _, b, _ in attachments) > MAX_ATTACH:
        raise GmailError("The attachments are over 20 MB together; Gmail would refuse them.")
    msg = EmailMessage()
    if to:
        msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    for name, data, mime in attachments:
        main, _, sub = mime.partition("/")
        msg.add_attachment(data, maintype=main or "application", subtype=sub or "octet-stream", filename=name)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    code, out = http("POST", DRAFTS, {"Authorization": f"Bearer {_access()}", "Content-Type": "application/json"}, json.dumps({"message": {"raw": raw}}).encode())
    if code == 401:
        raise GmailError("Google rejected the sign-in. Press Connect Gmail again.")
    if code != 200 or not out.get("id"):
        raise GmailError(f"Gmail did not create the draft ({(out.get('error') or {}).get('message', code) if isinstance(out.get('error'), dict) else out.get('error') or code}).")
    mid = (out.get("message") or {}).get("id", "")
    return {"draft_id": out["id"], "message_id": mid, "url": f"https://mail.google.com/mail/u/0/#drafts?compose={mid}" if mid else "https://mail.google.com/mail/u/0/#drafts"}


def compose_url(to: str, subject: str, body: str) -> str:
    """No sign-in needed, but no attachments either: Gmail's own compose window pre-filled."""
    q = urllib.parse.urlencode({"view": "cm", "fs": "1", "to": to, "su": subject, "body": body}, quote_via=urllib.parse.quote)
    return "https://mail.google.com/mail/?" + q
