#!/usr/bin/env python3
"""Thin JobSpy wrapper for scan-jobspy.mjs.

Reads one JSON object on stdin:
  {"sites": ["naukri", "indeed", "linkedin"], "terms": ["software engineer fresher"],
   "location": "India", "hours_old": 72, "results_wanted": 100,
   "site_max_terms": {"linkedin": 4, "indeed": 6}, "call_timeout": 90}
and prints one JSON object per posting on stdout (JSON Lines), plus a final
{"_errors": {...}} line when a board failed.

Each (site, term) pair is its own call, so one slow or blocked board cannot
take the others down. Failed calls retry with backoff ("retries", "backoff"); a
site that fails "breaker" calls in a row is skipped and tried once more in a
final pass after "final_pass_wait" seconds. When MINE_PROGRESS=1 it also prints "@@PROGRESS" and
"@@FAIL" lines on stderr for tools/mine.py. Run it with the venv python:
  tools/.venv-jobspy/bin/python tools/jobspy_scan.py < request.json
"""
import json
import os
import sys
import threading
import time

from jobspy import scrape_jobs

PROGRESS = os.environ.get("MINE_PROGRESS") == "1"


def emit(kind, *parts):
    if PROGRESS:
        # label and message are tab separated so labels can contain spaces
        text = " ".join(str(p) for p in parts) if kind == "PROGRESS" else parts[0] + "\t" + " ".join(str(p) for p in parts[1:])
        print(f"@@{kind} " + text, file=sys.stderr, flush=True)


def clean(v):
    # pandas NaN / NaT / numpy types -> JSON-safe values
    try:
        if v != v:
            return None
    except Exception:
        pass
    return v if isinstance(v, (str, int, float, bool, type(None))) else str(v)


def call_with_timeout(kwargs, timeout):
    """scrape_jobs in a daemon thread so a hung board cannot block the run."""
    box = {}

    def work():
        try:
            box["df"] = scrape_jobs(**kwargs)
        except Exception as exc:  # noqa: BLE001 - reported, not swallowed
            box["exc"] = exc

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"no answer after {timeout}s")
    if "exc" in box:
        raise box["exc"]
    return box["df"]


def attempt(site, term, req, timeout):
    """One scrape. Returns (df, error). JobSpy reports most failures in df.attrs, not as exceptions."""
    try:
        df = call_with_timeout(
            dict(site_name=[site], search_term=term, location=req.get("location", "India"),
                 country_indeed="India", hours_old=req.get("hours_old", 72),
                 results_wanted=req.get("results_wanted", 100), verbose=0),
            timeout,
        )
    except Exception as exc:  # reported, never fatal
        return None, str(exc)[:200]
    errs = df.attrs.get("errors") or {}
    if errs and len(df) == 0:
        return None, "; ".join(str(v) for v in errs.values())[:200]
    return df, None


def scrape_with_retries(site, term, req, timeout, retries, backoff):
    label = f"{site}: {term}"
    err = None
    for n in range(retries + 1):
        df, err = attempt(site, term, req, timeout)
        if df is not None:
            return df, None
        if n < retries:
            wait = backoff[min(n, len(backoff) - 1)]
            emit("RETRY", label, f"attempt {n + 1} failed, retrying in {wait}s:", err)
            time.sleep(wait)
    return None, err


def write_rows(df, term, seen):
    added = 0
    for rec in df.to_dict(orient="records"):
        url = rec.get("job_url")
        if not url or url in seen:
            continue
        seen.add(url)
        added += 1
        row = {k: clean(rec.get(k)) for k in (
            "site", "title", "company", "location", "job_url", "job_url_direct",
            "date_posted", "job_type", "experience_range", "job_level", "description",
        )}
        row["term"] = term
        print(json.dumps(row), flush=True)
    return added


def main():
    req = json.load(sys.stdin)
    sites = req.get("sites", ["naukri"])
    terms = req["terms"]
    caps = req.get("site_max_terms", {})
    timeout = req.get("call_timeout", 120)
    retries = req.get("retries", 4)
    backoff = req.get("backoff", [10, 30, 60, 120])
    breaker = req.get("breaker", 5)
    final_wait = req.get("final_pass_wait", 180)

    plan = [(site, term) for term in terms for site in sites if terms.index(term) < caps.get(site, len(terms))]
    total = len(plan)
    errors, seen = {}, set()
    streak = {s: 0 for s in sites}
    tripped, deferred = set(), []
    done = 0

    def run(site, term, tries):
        nonlocal done
        label = f"{site}: {term}"
        emit("PROGRESS", f"{done}/{total}", label)
        started = time.time()
        df, err = scrape_with_retries(site, term, req, timeout, tries, backoff)
        done += 1
        if df is None:
            errors[label] = err
            emit("FAIL", label, err)
            emit("PROGRESS", f"{done}/{total}", f"{label} -> failed in {time.time() - started:.0f}s")
            return False
        errors.pop(label, None)
        added = write_rows(df, term, seen)
        emit("PROGRESS", f"{done}/{total}", f"{label} -> {added} new in {time.time() - started:.0f}s")
        return True

    for site, term in plan:
        if site in tripped:
            deferred.append((site, term))
            emit("SKIP", f"{site}: {term}", f"{site} failed {breaker} calls in a row, deferred to final pass")
            continue
        if run(site, term, retries):
            streak[site] = 0
        else:
            streak[site] += 1
            if streak[site] >= breaker:
                tripped.add(site)
                emit("SKIP", site, f"circuit open after {breaker} failures in a row")

    if deferred:
        emit("PROGRESS", f"{done}/{total}", f"final pass: waiting {final_wait}s before retrying {sorted(tripped)}")
        time.sleep(final_wait)
        alive = set(tripped)
        final_streak = {s: 0 for s in tripped}
        for site, term in deferred:
            if site not in alive:
                done += 1
                errors[f"{site}: {term}"] = "skipped: site still failing in final pass"
                emit("FAIL", f"{site}: {term}", errors[f"{site}: {term}"])
                emit("PROGRESS", f"{done}/{total}", f"{site}: {term} -> skipped")
                continue
            if run(site, term, retries):
                final_streak[site] = 0
            else:
                final_streak[site] += 1
                if final_streak[site] >= 2:
                    alive.discard(site)

    if errors:
        print(json.dumps({"_errors": errors}), flush=True)
    sys.stdout.flush()
    # Daemon threads from timed-out calls may still be running; do not wait for them.
    os._exit(0)


if __name__ == "__main__":
    main()
