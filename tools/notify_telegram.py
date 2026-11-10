"""Telegram ping for new jobs, called by mine.py after each real run.

Silent when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set, so a machine without them behaves as before.
Create a bot with @BotFather, send it one message, read your chat id from
https://api.telegram.org/bot<token>/getUpdates, and put both lines in career-ops/.env (TELEGRAM_BOT_TOKEN=... and TELEGRAM_CHAT_ID=...), or export them.

Never raises: a failed ping is reported and the run carries on. At most MAX_ROWS jobs per message, MAX_MESSAGES per run;
the rest are summarised as a count. Rows are ranked India-fresher-first (fresher/intern/2027/SDE-1 in the title, then the
rest). Aggregator rows are marked so you know they need confirming at the employer.
"""
import html
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

MAX_ROWS = 12
MAX_MESSAGES = 3
API = "https://api.telegram.org/bot{token}/sendMessage"
FRESHER = ("fresher", "intern", "graduate", "trainee", "2027", "2026", "sde 1", "sde-1", "sde i ", "associate", "entry", "junior")


def _score(row):
    t = (row.get("title") or "").lower()
    return -sum(1 for k in FRESHER if k in t)


def format_messages(rows, run_label=""):
    """HTML messages (each under Telegram's 4096-char limit) for the new rows. Returns [] when there is nothing to send."""
    if not rows:
        return []
    ranked = sorted(rows, key=_score)
    shown = ranked[: MAX_ROWS * MAX_MESSAGES]
    msgs, cur = [], []
    for i, r in enumerate(shown):
        mark = " (unconfirmed)" if (r.get("confidence") or "aggregator") != "employer-confirmed" else ""
        line = (f"<b>{html.escape(str(r.get('title') or '?'))[:110]}</b>\n"
                f"{html.escape(str(r.get('company') or '?'))[:60]} | {html.escape(str(r.get('location') or '?'))[:60]}{mark}\n"
                f"{html.escape(str(r.get('url') or ''))}")
        cur.append(line)
        if len(cur) == MAX_ROWS or i == len(shown) - 1:
            msgs.append("\n\n".join(cur))
            cur = []
    head = f"New jobs{(' ' + run_label) if run_label else ''}: {len(rows)}" + (f" (showing {len(shown)})" if len(shown) < len(rows) else "")
    msgs[0] = head + "\n\n" + msgs[0]
    return [m[:4000] for m in msgs]


def _from_env_file(name, env_file=None):
    """Value of NAME from the data root's .env (career-ops/.env), or None. Real environment variables win over it."""
    path = Path(env_file) if env_file else Path(os.environ.get("CAREER_OPS_ROOT") or Path(__file__).resolve().parents[2] / "career-ops") / ".env"
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            key, sep, val = line.strip().partition("=")
            if sep and key.strip() == name:
                return val.strip().strip("\"'") or None
    except OSError:
        pass
    return None


def send_new(rows, run_label="", token=None, chat_id=None, opener=urllib.request.urlopen):
    """Send the new rows. Returns (sent_count, note). Never raises."""
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN") or _from_env_file("TELEGRAM_BOT_TOKEN")
    chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID") or _from_env_file("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return 0, "telegram: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set, no ping"
    sent = 0
    try:
        for m in format_messages(rows, run_label):
            data = urllib.parse.urlencode({"chat_id": chat_id, "text": m, "parse_mode": "HTML", "disable_web_page_preview": "true"}).encode()
            with opener(urllib.request.Request(API.format(token=token), data=data), timeout=20) as resp:
                if json.loads(resp.read().decode()).get("ok") is not True:
                    return sent, "telegram: API answered not ok"
            sent += 1
    except Exception as e:  # noqa: BLE001: a failed ping must never fail the run
        return sent, f"telegram: ping failed after {sent} message(s): {type(e).__name__}"
    return sent, f"telegram: {sent} message(s) sent"
