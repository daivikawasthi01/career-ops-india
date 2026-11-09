"""Source health, scan windows and failure classes (Phase 5). Pure functions; the caller passes history and clock."""
import math
import re
from datetime import datetime
from statistics import median

import pipeline_cfg

OK, DEGRADED, DEAD, FAILED = "OK", "DEGRADED", "DEAD", "FAILED"


def settings():
    return {"history_runs": 14, "degraded_ratio": 0.4, "min_history": 3, **pipeline_cfg.section("health")}


def baseline(history, cfg=None):
    """Median fetched count of the recent successful real runs, or None when there are too few."""
    cfg = cfg or settings()
    counts = [h["fetched"] for h in history[: cfg["history_runs"]]
              if h.get("status") in ("ok", "partial") and h.get("fetched") is not None]
    return median(counts) if len(counts) >= cfg["min_history"] else None


def assess(fetched, run_status, history, cfg=None):
    """Health of one run. 'At least one result' is not healthy:
    FAILED  the scanner itself failed
    DEAD    it ran but fetched nothing
    DEGRADED fetched under degraded_ratio of its median
    OK      otherwise (also when there is not enough history to judge)"""
    cfg = cfg or settings()
    if run_status == "failed":
        return FAILED, "scanner failed"
    if not fetched:
        med = baseline(history, cfg)
        return DEAD, f"fetched 0 (median {med:g})" if med else "fetched 0"
    med = baseline(history, cfg)
    if med and fetched < cfg["degraded_ratio"] * med:
        return DEGRADED, f"fetched {fetched}, under {cfg['degraded_ratio']:.0%} of median {med:g}"
    return OK, ""


def exit_code(runs):
    """0 all healthy, 1 a source FAILED or is DEAD, 3 a source is DEGRADED."""
    healths = {r.get("health") for r in runs}
    if healths & {FAILED, DEAD}:
        return 1
    if DEGRADED in healths:
        return 3
    return 0


def window_days(last_success_iso, explicit_days=None, now=None, cfg=None):
    """Days to fetch: --days wins; else since the last success plus overlap; else the default."""
    cfg = {"overlap_days": 1, "default_days": 3, "max_days": 14, **(cfg or pipeline_cfg.section("window"))}
    if explicit_days:
        return explicit_days
    if not last_success_iso:
        return cfg["default_days"]
    try:
        gap = (now or datetime.now()) - datetime.fromisoformat(last_success_iso)
    except ValueError:
        return cfg["default_days"]
    days = math.ceil(max(gap.total_seconds(), 0) / 86400) + cfg["overlap_days"]
    return max(1, min(days, cfg["max_days"]))


_CLASSES = [
    ("rate_limited", r"\b429\b|rate.?limit|too many requests|throttl"),
    ("not_found", r"\b404\b|\b410\b|not found|slug_gone|gone"),
    ("timeout", r"timed? ?out|timeout|no answer after|ETIMEDOUT|AbortError"),
    ("parse_error", r"parse|json|unexpected token|invalid|malformed|decode"),
    ("empty", r"\bempty\b|no results|zero (?:rows|results)|returned nothing"),
    ("auth", r"\b40[13]\b|forbidden|unauthori[sz]ed|captcha|blocked"),
    ("server_error", r"\b5\d\d\b|server error|bad gateway|service unavailable"),
    ("network", r"ECONN|ENOTFOUND|network|dns|socket|refused|reset|fetch failed"),
]


def classify_failure(message):
    """timeout / rate_limited / not_found / parse_error / empty / auth / server_error / network / other."""
    text = str(message or "")
    for name, pattern in _CLASSES:
        if re.search(pattern, text, re.I):
            return name
    return "other"


def summary_table(rows):
    """rows: dicts with source, fetched, kept, new, duplicates, errors, health, seconds. Plain text table."""
    cols = ["source", "fetched", "kept", "new", "dupes", "errors", "health", "secs"]
    body = [[r["source"], r.get("fetched", "-"), r.get("kept", "-"), r.get("new", "-"), r.get("duplicates", "-"),
             r.get("errors", 0), r.get("health", "-"), r.get("seconds", "-")] for r in rows]
    widths = [max(len(str(x)) for x in [c] + [b[i] for b in body]) for i, c in enumerate(cols)]
    line = lambda cells: "  ".join(str(c).ljust(w) for c, w in zip(cells, widths)).rstrip()  # noqa: E731
    return "\n".join([line(cols), line(["-" * w for w in widths]), *[line(b) for b in body]])
