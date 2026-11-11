"""Sharing usage with whoever gave you this tool, only if you choose to.

Two ways:
  text    "Copy my stats": a short summary you can paste to them whenever you like. Nothing is sent by the app.
  ping    an anonymous report sent once a day to the address in config.yaml (share.url). It is inert when no address is set, and the You tab
          and README say it exists. Someone who does not want it sets share.enabled: false in config.local.yaml.

The report holds counts only: a random install id, the app version, the operating system, whether setup is finished, how many forms,
answers and drafts were handled this week, in the last 30 days and in total, how many days you used it, and what failed in the last 7 days
(the action's name and a fixed category such as model_rate_limited, with a count; never the error text). It never holds your name, email,
CV, answers, company names, job links or keys. The exact report is shown in the You tab.
"""
from __future__ import annotations

import json
import platform
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from . import account, config, errors

STATE = config.ROOT / "data" / "share.json"
_EVERY = timedelta(hours=24)


def _read() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def _write(d: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(d))


def url() -> str:
    return str((config.load().get("share") or {}).get("url") or "").strip()


def _version() -> str:
    try:
        return json.loads((config.ROOT / "browser" / "manifest.json").read_text()).get("version", "")
    except (OSError, ValueError):
        return ""


def _install_id() -> str:
    d = _read()
    if not d.get("id"):
        d["id"] = secrets.token_hex(8)
        _write(d)
    return d["id"]


def _window(conn, days: int | None) -> dict:
    cond = f"WHERE at >= datetime('now', '-{int(days)} days')" if days else ""
    got = {k: n for k, n in conn.execute(f"SELECT kind, COALESCE(SUM(n),0) FROM usage_events {cond} GROUP BY kind").fetchall()}
    return {"forms": got.get("form", 0), "fills": got.get("fill", 0), "drafts": got.get("draft", 0)}


def report(conn) -> dict:
    """The whole payload, so the panel can show exactly what would be sent."""
    ready = account.readiness()
    active = conn.execute("SELECT COUNT(DISTINCT date(at)) FROM usage_events WHERE at >= datetime('now', '-30 days')").fetchone()[0]
    return {"install": _install_id(), "version": _version(), "os": platform.system(),
            "setup_done": ready["ready"], "setup_steps_done": sum(1 for s in ready["steps"] if s["done"]), "setup_steps": len(ready["steps"]),
            "week": _window(conn, 7), "month": _window(conn, 30), "total": _window(conn, None), "days_active_30": active,
            "errors": errors.summary(conn)}


def text(conn) -> str:
    """The plain-text summary for "Copy my stats". No install id, nothing identifying."""
    s = account.stats(conn)
    r = report(conn)
    m = r["month"]
    return (f"Apply stats\nVersion {r['version']} on {r['os']}\nSetup: {'finished' if r['setup_done'] else f'{r['setup_steps_done']} of {r['setup_steps']} steps'}\n"
            f"Last 7 days: {s['week']['fills']} answers filled on {s['week']['forms']} forms, {s['week']['drafts']} drafts\n"
            f"Last 30 days: {m['fills']} answers filled on {m['forms']} forms, {m['drafts']} drafts, used on {r['days_active_30']} days\n"
            f"All time: {s['all']['fills']} answers, {s['all']['drafts']} drafts, about {s['all']['minutes_saved']} minutes saved")


def enabled() -> bool:
    return bool(url()) and (config.load().get("share") or {}).get("enabled", True) is not False


def state(conn) -> dict:
    d = _read()
    return {"enabled": enabled(), "available": bool(url()), "last_sent": d.get("last_sent", ""), "error": d.get("error", ""),
            "report": report(conn)}


def send(conn, post=None) -> dict:
    """Send the report once. `post` is the network call, replaced in tests."""
    if not url():
        raise ValueError("Sharing is not set up for this copy of the app.")
    body = json.dumps(report(conn)).encode()
    d = _read()
    try:
        if post:
            post(url(), body)
        else:
            req = urllib.request.Request(url(), data=body, headers={"Content-Type": "application/json", "User-Agent": "apply-extension"}, method="POST")
            urllib.request.urlopen(req, timeout=15).read()
        d.update(last_sent=datetime.now(timezone.utc).isoformat(timespec="seconds"), error="")
    except (urllib.error.URLError, OSError, ValueError) as e:
        d["error"] = f"Could not send: {e}"[:160]
    _write(d)
    return {"last_sent": d.get("last_sent", ""), "error": d.get("error", "")}


def due() -> bool:
    d = _read()
    if not enabled():
        return False
    try:
        return datetime.now(timezone.utc) - datetime.fromisoformat(d["last_sent"]) > _EVERY
    except (KeyError, ValueError):
        return True


def loop(db_path: str) -> None:
    """Background: once an hour, send when switched on and a day has passed since the last report."""
    from . import db
    while True:
        try:
            if due():
                with db.tx(db_path) as conn:
                    send(conn)
        except Exception:   # sharing must never disturb the app
            pass
        time.sleep(3600)
