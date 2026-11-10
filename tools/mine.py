#!/usr/bin/env python3
"""Front end for the India entry-level scanners.

Runs each Node scanner as a subprocess with MINE_PROGRESS=1, shows a tqdm bar
from its "@@PROGRESS done/total label" lines, keeps a full log, and rewrites the
Excel workbook after every step so a crash never loses finished work.

  tools/.venv-jobspy/bin/python tools/mine.py --days 3 --sites naukri,indeed,linkedin
  tools/.venv-jobspy/bin/python tools/mine.py --dry-run

Source feeders (tools/feeders.py) run first when due: they refresh the lists the scanners read (careers directory, verified
directory boards, India ATS tenants, Telegram employer names, campus pages) and write reviewable files under data/.
Skip them with --no-feeders; run one now with --steps <id>. Unstop and every portals.yml job_boards entry are read by the portals step.

Slow lane: LinkedIn and Glassdoor rate-limit, so they are not part of the first pass. After a real default run has saved its jobs
and sent the Telegram ping, mine.py starts a detached background lane (--slow, config jobspy.slow) that runs a few of their searches
per batch, one batch an hour, last day only, each batch saving and pinging on its own. Run one batch by hand with --slow, or
let cron do it hourly. --no-slow skips the automatic start.

Outputs (under output/): mine-YYYY-MM-DD.xlsx and logs/mine-YYYYMMDD-HHMMSS.log
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from openpyxl import Workbook
from openpyxl.styles import Font
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dedup  # noqa: E402
import feeders  # noqa: E402
import freshness  # noqa: E402
import notify_telegram  # noqa: E402
from canonical import canonical_url  # noqa: E402
import health  # noqa: E402
import pipeline_cfg  # noqa: E402
import store  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "output"
STATE = ROOT / "data" / "cache" / "mine-state.json"  # last successful run per step

LINE = re.compile(r"^@@(PROGRESS|FAIL|RETRY|SKIP) (.*)$")
PROG = re.compile(r"^(\d+)/(\d+)\s*(.*)$")


def load_state(path=STATE):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state, path=STATE):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)


def _entry(state, step_id):
    """State entry as (timestamp, coverage). Old files stored a bare timestamp string."""
    raw = state.get(step_id)
    if isinstance(raw, dict):
        return raw.get("at"), raw.get("coverage")
    return raw, None


def record_run(state, status, dry_run, now=None):
    """Remember a successful (ok or partial) real run and its coverage. Dry runs never move the schedule.
    Returns True when the state changed and should be saved."""
    if dry_run or status["status"] not in ("ok", "partial"):
        return False
    now = now or datetime.now()
    state[status["id"]] = {"at": now.isoformat(timespec="seconds"), "coverage": status.get("coverage")}
    return True


def steps_given(argv):
    """True when the user named --steps themselves, which always runs exactly those steps."""
    return any(a == "--steps" or a.startswith("--steps=") for a in argv)


def receipt_coverage(receipt):
    """Share of boards that answered, from scan-ats-full's summary: 1 - unreachable / scanned."""
    try:
        scanned = float(receipt["companiesScanned"])
        unreachable = float(receipt["unreachableBoards"])
    except (KeyError, TypeError, ValueError):
        return None
    return None if scanned <= 0 else max(0.0, min(1.0, 1 - unreachable / scanned))


# Argument builders for the registered steps (config/pipeline.yml `steps:`): id -> f(args, window_days) -> scanner arguments.
STEP_ARGS = {
    "freehire": lambda a, w: ["--days", str(w), "--max-pages", str(a.freehire_pages)],
    "internshala": lambda a, w: ["--days", str(w + 1), "--max-pages", str(a.internshala_pages)],
    "jobspy": lambda a, w: ["--days", str(w), "--sites", a.sites],
    "portals": lambda a, w: ["--since", str(max(w, employer_window_days()))],
    "ats": lambda a, w: ["--since", str(a.ats_days), "--ats", a.ats_sources, *(["--limit", str(a.ats_limit)] if a.ats_limit else [])],
    "slow": lambda a, w: [],
}


def employer_window_days():
    """Scan window for company career pages and ATS boards: wide, because they keep postings open for months (freshness.employer_max_age_days).
    Board and aggregator rows older than freshness.max_age_days are dropped by the freshness gate."""
    return int((pipeline_cfg.section("freshness") or {}).get("employer_max_age_days") or 0)


def step_registry():
    return pipeline_cfg.section("steps", [])


def windowed_ids(registry=None):
    return [e["id"] for e in (registry if registry is not None else step_registry()) if e.get("windowed")]


def default_step_ids(registry=None):
    return [e["id"] for e in (registry if registry is not None else step_registry()) if not e.get("standalone")]


def make_step(entry, args, windows=None):
    """One scanner invocation from a registry entry. The step's id is its state_id, so a standalone step records under its own key."""
    window = (windows or {}).get(entry["id"], args.days or 3)
    flags = ["--dry-run"] if args.dry_run else []
    step = {"id": entry.get("state_id", entry["id"]), "file": entry["file"],
            "args": [*([entry["cli"]] if entry.get("cli") else []), *STEP_ARGS[entry["id"]](args, window), *flags]}
    if entry.get("bare_json"):
        step["bare_json"] = True  # scan.mjs and scan-ats-full.mjs take a bare --json (receipt on stdout, no file path)
    return step


def build_steps(args, windows=None, registry=None):
    registry = registry if registry is not None else step_registry()
    wanted = [x.strip() for x in args.steps.split(",")]
    return [make_step(e, args, windows) for e in registry if not e.get("standalone") and e["id"] in wanted]


def norm_url(url):
    try:
        u = urlparse(url)
        key = f"{u.hostname or ''}".removeprefix("www.").lower() + u.path.rstrip("/").lower()
        # Indeed identifies the posting only by ?jk=, so the query must stay in the key
        jk = parse_qs(u.query).get("jk") or parse_qs(u.query).get("vjk")
        return key + (f"?jk={jk[0]}" if jk else "")
    except Exception:
        return str(url or "").lower()


def site_of(offer):
    host = (urlparse(offer.get("url") or "").hostname or "").lower()
    for key in dedup.KNOWN_SITES:
        if key in host:
            return key
    return str(offer.get("source") or "unknown").split(":")[-1].lower()


def merge(per_step):
    """One row per job across all steps: canonical URL or company+title+city, best URL kept (tools/dedup.py)."""
    rows = dedup.merge_offers(per_step)
    for r in rows:
        r["site"] = site_of(r)
    return rows


def dedup_report(per_step, path, sample=30):
    """Duplicates collapsed per platform pair, plus a sample of merged and of similar-but-unmerged rows to eyeball."""
    import random
    rows = merge(per_step)
    stats = dedup.collapse_stats(rows)
    rng = random.Random(0)
    merged = [r for r in rows if len(r["found_by"]) > 1]
    similar = dedup.similar_unmerged(rows)
    lines = ["# Dedup report", "", f"{sum(len(o) for o in per_step.values())} offers in, {len(rows)} jobs out, "
             f"{len(merged)} jobs found by more than one source.", "", "## Collapsed per source pair", ""]
    lines += [f"- {a} + {b}: {n}" for (a, b), n in sorted(stats.items(), key=lambda kv: -kv[1])] or ["- none"]
    lines += ["", f"## {min(sample, len(merged))} merged rows (check these really are one job)", ""]
    for r in rng.sample(merged, min(sample, len(merged))):
        lines.append(f"- {r.get('company')} | {r.get('title')} | {r.get('location')} | found by {', '.join(r['found_by'])}")
        lines += [f"    - {u}" for u in r["urls"]]
    lines += ["", f"## {min(sample, len(similar))} similar rows that did NOT merge (check these really are different)", ""]
    for a, b in rng.sample(similar, min(sample, len(similar))):
        lines.append(f"- {a.get('company')}: \"{a.get('title')}\" ({a.get('location')}) vs \"{b.get('title')}\" ({b.get('location')})")
    path.write_text("\n".join(lines) + "\n")
    return stats, len(merged)


def db_rows(conn, run_id):
    """Jobs seen in this run, read back from the database (what the final workbook is generated from)."""
    out = []
    for r in conn.execute("SELECT * FROM jobs WHERE last_run_id=? ORDER BY company, title", (run_id,)):
        d = dict(r)
        d["found_by"] = json.loads(d["found_by"] or "[]")
        d["is_new"] = d["first_run_id"] == run_id
        d["site"] = site_of(d)
        d["source"] = ""
        out.append(d)
    return out


def write_excel(path, rows, runs, failures, started):
    wb = Workbook()
    ws = wb.active
    ws.title = "Offers"
    ws.append(["Company", "Title", "Location", "Site", "Found by", "Link", "Confidence", "Flags", "Status", "New"])
    for o in sorted(rows, key=lambda x: (x.get("site", ""), str(x.get("company") or ""))):
        flags = o.get("flags") or ""
        ws.append([o.get("company") or "", o.get("title") or "", o.get("location") or "", o.get("site", ""),
                   ", ".join(o.get("found_by") or []), o.get("url") or "", o.get("confidence") or "",
                   "; ".join(flags) if isinstance(flags, list) else flags, o.get("status") or "new",
                   "yes" if o.get("is_new", True) else ""])
        cell = ws.cell(row=ws.max_row, column=6)  # Link
        if cell.value:
            cell.hyperlink = cell.value
            cell.font = Font(color="0563C1", underline="single")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    wr = wb.create_sheet("Runs")
    wr.append(["Step", "Status", "Health", "Seconds", "Fetched", "Kept", "New", "Duplicates", "Errors", "Window days", "Note"])
    for r in runs:
        wr.append([r["id"], r["status"], r.get("health", ""), r["secs"], r.get("fetched", ""), r.get("kept", r["count"]),
                   r.get("new", ""), r.get("duplicates", ""), r.get("errors", ""), r.get("window_days", ""),
                   "; ".join(x for x in (r["note"], r.get("health_note", "")) if x)])

    wf = wb.create_sheet("Failures")
    wf.append(["Step", "Kind", "Class", "What", "Message"])
    for f in failures:
        wf.append([f["step"], f["kind"], f.get("class") or health.classify_failure(f["message"]), f["label"], f["message"]])

    for sheet, widths in ((ws, (28, 50, 28, 12, 22, 60, 18, 28, 12, 6)), (wr, (14, 10, 10, 9, 9, 7, 7, 11, 8, 12, 60)),
                          (wf, (14, 8, 14, 40, 90))):
        for i, w in enumerate(widths):
            sheet.column_dimensions[chr(65 + i)].width = w
        for c in sheet[1]:
            c.font = Font(bold=True)
    wb.properties.title = f"mine run {started:%Y-%m-%d %H:%M}"
    tmp = path.with_suffix(".xlsx.tmp")
    wb.save(tmp)
    tmp.replace(path)


TICK = re.compile(r"scan: (\d+)/(\d+)")
ATS_TICK = re.compile(r"(\d+)\s*/\s*(\d+)")


def parse_bare_line(step_id, line, bar):
    """Progress ticks and the stdout receipt of scan.mjs / scan-ats-full.mjs. Offers come from the --json file, not from here."""
    text = line.lstrip()
    if text.startswith("{"):
        try:
            ev = json.loads(text)
        except json.JSONDecodeError:
            return None
        return ev if ("added_urls" in ev or "postingsKept" in ev) else None
    if step_id == "portals":
        t = TICK.search(line)
        if t:
            bar.total, bar.n = max(int(t.group(2)), 1), min(int(t.group(1)), int(t.group(2)))
            bar.refresh()
    elif step_id == "ats":
        t = ATS_TICK.search(line)
        if t and int(t.group(2)) > 0:
            bar.total, bar.n = int(t.group(2)), min(int(t.group(1)), int(t.group(2)))
            bar.refresh()
    return None


def receipt_fetched(step_id, receipt, stats, kept):
    """How many postings the scanner read before its own filters. Each scanner reports this differently."""
    if stats.get("fetched") is not None:
        return stats["fetched"]
    r = receipt or {}
    if step_id == "portals" and r.get("found") is not None:
        return r["found"]
    if step_id == "ats" and "postingsKept" in r:
        return sum(int(r.get(k) or 0) for k in ("postingsKept", "postingsDroppedNoDate", "postingsDroppedContent", "postingsFilteredBlacklist"))
    return kept


def run_step(step, log, failures, position):
    """Run one scanner, drive its bar, return (offers, status dict)."""
    json_path = Path(tempfile.mkdtemp(prefix="mine-")) / f"{step['id']}.json"
    cmd = ["node", str(ROOT / step["file"]), *step["args"], "--json", str(json_path)]
    env = {**os.environ, "MINE_PROGRESS": "1"}
    log.write(f"\n===== {step['id']}: {' '.join(cmd)}\n")
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    bar = tqdm(total=1, desc=step["id"], position=position, leave=True, unit="call",
               bar_format="{desc:<12} {percentage:3.0f}%|{bar:24}| {n_fmt}/{total_fmt} [{elapsed}] {postfix}")
    fails = retries = 0
    tail = []
    receipt = None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        log.write(line + "\n")
        log.flush()
        m = LINE.match(line)
        if not m:
            tail = (tail + [line])[-6:]
            if step.get("bare_json"):
                receipt = parse_bare_line(step["id"], line, bar) or receipt
            continue
        kind, rest = m.groups()
        if kind == "PROGRESS":
            p = PROG.match(rest)
            if p:
                bar.total = max(int(p.group(2)), 1)
                bar.n = min(int(p.group(1)), bar.total)
                bar.set_postfix_str(p.group(3)[:48], refresh=True)
        else:
            label, _, message = rest.partition("\t")
            fails += kind == "FAIL"
            retries += kind == "RETRY"
            failures.append({"step": step["id"], "kind": kind.lower(), "label": label, "message": message[:300]})
            bar.set_postfix_str(f"{fails} failed, {retries} retried", refresh=True)
    code = proc.wait()
    bar.n = bar.total
    bar.refresh()
    bar.close()
    secs = round(time.time() - started)
    offers = []
    offers_ok = True
    if json_path.exists():
        try:
            offers = json.loads(json_path.read_text())
        except json.JSONDecodeError:
            offers_ok = False
    else:
        offers_ok = False
    stats = {}
    stats_path = Path(str(json_path) + ".stats.json")
    if stats_path.exists():
        try:
            stats = json.loads(stats_path.read_text())
        except json.JSONDecodeError:
            pass
    shutil.rmtree(json_path.parent, ignore_errors=True)
    board_errors = (receipt or {}).get("errors") or []
    for e in board_errors:
        fails += 1
        failures.append({"step": step["id"], "kind": "fail", "label": str(e.get("company")), "message": str(e.get("error"))[:300]})
    # scan.mjs exits 2 when some boards errored but the run completed and wrote a receipt
    if code == 2 and receipt is not None:
        code = 0
    if code == 0 and not offers_ok and step.get("bare_json"):
        code = 3
        tail = tail + ["no readable --json offers file"]
    if code != 0:
        status, note = "failed", f"exit {code}: " + " / ".join(tail[-3:])
    elif fails:
        status, note = "partial", f"{fails} failed calls, {retries} retries"
    else:
        status, note = "ok", f"{retries} retries" if retries else ""
    log.write(f"===== {step['id']} done: {status}, {len(offers)} offers, {secs}s\n")
    coverage = receipt_coverage(receipt) if step.get("bare_json") and step["id"] == "ats" else None
    if coverage is not None:
        note = (note + "; " if note else "") + f"{coverage:.0%} of boards read"
    fetched = receipt_fetched(step["id"], receipt, stats, len(offers))
    return offers, {"id": step["id"], "status": status, "secs": secs, "count": len(offers), "note": note, "coverage": coverage,
                    "fetched": fetched, "kept": len(offers), "errors": fails, "stats": stats}


def run_feeder(feeder, log):
    """Run one source feeder (a tool that refreshes the boards/companies/pages the scanners read). Never raises.
    Returns a status dict like run_step's, with no offers."""
    cmd = ["node", str(ROOT / "tools" / feeder["file"]), *feeder["args"]]
    log.write(f"\n===== feeder {feeder['id']}: {' '.join(cmd)}\n")
    started = time.time()
    tail = []
    try:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=feeder.get("timeout", 1800))
        out = (proc.stdout or "") + (proc.stderr or "")
        log.write(out + "\n")
        tail = [l for l in out.splitlines() if l.strip()][-1:]
        code = proc.returncode
    except subprocess.TimeoutExpired:
        code, tail = 124, ["timed out"]
    except OSError as e:
        code, tail = 127, [str(e)]
    status = "ok" if code == 0 else "failed"
    log.write(f"===== feeder {feeder['id']} done: {status} in {round(time.time() - started)}s\n")
    return {"id": feeder["id"], "status": status, "secs": round(time.time() - started), "note": (tail[0] if tail else "")[:160]}


SLOW_LOCK = ROOT / "data" / "cache" / "slow-lane.pid"


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def slow_lane_running(lock=SLOW_LOCK):
    try:
        return _alive(int(lock.read_text().strip()))
    except (OSError, ValueError):
        return False


def jobspy_sites(flag):
    """Site names flagged in the config table (config/pipeline.yml jobspy.sites): first_pass or slow."""
    table = pipeline_cfg.section("jobspy").get("sites") or {}
    return [name for name, row in table.items() if (row or {}).get(flag)]


def slow_plan(cfg, slow_sites=None):
    """(batches, gap_minutes) for the automatic lane, or None when no site is flagged slow."""
    cfg = cfg or {}
    if not (jobspy_sites("slow") if slow_sites is None else slow_sites):
        return None
    return max(int(cfg.get("batches", 8)), 1), max(int(cfg.get("gap_minutes", 60)), 1)


def start_slow_lane(lock=SLOW_LOCK):
    """Start the detached slow lane unless one is already running. Returns a one-line note."""
    plan = slow_plan(pipeline_cfg.section("jobspy").get("slow"))
    if not plan:
        return "mine: slow lane has no sites configured (jobspy.slow.sites)"
    if slow_lane_running(lock):
        return "mine: slow lane already running, not starting another"
    batches, gap = plan
    log = (OUT / "logs" / f"slow-lane-{datetime.now():%Y%m%d-%H%M%S}.log").open("w")
    proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--slow", "--slow-batches", str(batches), "--slow-gap-min", str(gap)],
                            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    return f"mine: slow lane started in the background (pid {proc.pid}): {batches} batch(es), one every {gap} min, log {Path(log.name).relative_to(ROOT)}"


def run_slow_batches(batches, gap_minutes, lock=SLOW_LOCK, sleep=time.sleep):
    """Run --slow batches spread over time. Two failing batches in a row stop the lane (the sites are blocking us); the next
    default run starts it again."""
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(str(os.getpid()))
    failed_in_a_row = 0
    try:
        for i in range(batches):
            print(f"slow lane: batch {i + 1}/{batches} at {datetime.now():%H:%M}", flush=True)
            code = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--slow"], cwd=ROOT).returncode
            failed_in_a_row = failed_in_a_row + 1 if code not in (0,) else 0
            if failed_in_a_row >= 2:
                print("slow lane: two batches failed in a row, stopping", flush=True)
                return 1
            if i < batches - 1:
                sleep(gap_minutes * 60)
    finally:
        try:
            lock.unlink()
        except OSError:
            pass
    return 0


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=None, help="override the scan window; default is since each step's last success plus a day of overlap (config window:)")
    ap.add_argument("--sites", default=",".join(jobspy_sites("first_pass")), help="JobSpy sites for the first pass; the slow-flagged ones (LinkedIn, Glassdoor) run in the slow lane")
    ap.add_argument("--steps", default=",".join(default_step_ids()), help="comma list of steps to run")
    ap.add_argument("--ats-sources", default="greenhouse,lever,ashby", help="ATS directories for the reverse sweep")
    ap.add_argument("--ats-limit", type=int, default=0, help="max companies per ATS (0 = all)")
    ap.add_argument("--ats-days", type=int, default=employer_window_days() or 14, help="posting window for the ats step: company boards keep postings open for months (freshness.employer_max_age_days)")
    ap.add_argument("--freehire-pages", type=int, default=6, help="pages of 100 per freehire query")
    ap.add_argument("--internshala-pages", type=int, default=5, help="result pages per Internshala category")
    ap.add_argument("--no-feeders", action="store_true", help="skip the source feeders (careers directory, directory boards, India ATS tenant probe, Telegram employer names, campus page watch). A default run runs those that are due; naming one in --steps runs it now")
    ap.add_argument("--dry-run", action="store_true", help="scanners print matches and write nothing to the pipeline")
    ap.add_argument("--slow", action="store_true", help="run one small batch for the rate-limited sites (LinkedIn, Glassdoor; config jobspy.slow) instead of the normal steps")
    ap.add_argument("--slow-batches", type=int, default=1, help="with --slow: how many batches to run, one every --slow-gap-min minutes")
    ap.add_argument("--slow-gap-min", type=int, default=60, help="with --slow-batches: minutes between batches")
    ap.add_argument("--no-slow", action="store_true", help="do not start the background slow lane after the first pass")
    return ap


@dataclass
class RunPlan:
    explicit: bool   # the user named --steps, so exactly those run and nothing is skipped as "not due"
    windows: dict    # scan window in days per windowed step
    steps: list
    feeders: list
    notes: list


def plan_run(args, state, started, argv):
    """Decide what this run does: which steps, which feeders, which scan windows. Prints nothing and runs nothing."""
    explicit = steps_given(argv)
    windows = {sid: health.window_days((_entry(state, sid)[0]), args.days, started) for sid in windowed_ids()}
    steps = [x for x in build_steps(args, windows) if not (x["id"] == "jobspy" and not args.sites)]
    feeder_pick, feeder_notes = feeders.select_feeders(feeders.feeder_list(), [x.strip() for x in args.steps.split(",")] if explicit else [],
                                                       args.dry_run, args.no_feeders)
    if args.slow:  # only the slow lane's batch, no feeders
        steps = [make_step(e, args) for e in step_registry() if e.get("standalone") and e.get("cli") == "--slow"]
        feeder_pick, feeder_notes = [], []
    return RunPlan(explicit, windows, steps, feeder_pick, feeder_notes)


def execute_plan(plan, args, state, log, xlsx_path, started):
    """Run the feeders, then each step, saving the schedule and the workbook as it goes. Returns (feeder_runs, runs, per_step, failures)."""
    per_step, runs, failures, feeder_runs = {}, [], [], []
    for feeder in plan.feeders:
        print(f"mine: feeder {feeder['id']} ...", flush=True)
        fr = run_feeder(feeder, log)
        feeder_runs.append(fr)
        print(f"mine: feeder {fr['id']} {fr['status']} in {fr['secs']}s {fr['note']}", flush=True)
        if record_run(state, fr, args.dry_run):
            save_state(state)
    for i, step in enumerate(plan.steps):
        offers, status = run_step(step, log, failures, i)
        status["window_days"] = plan.windows.get(step["id"])
        per_step[step["id"]] = offers
        runs.append(status)
        if record_run(state, status, args.dry_run):
            save_state(state)
        write_excel(xlsx_path, merge(per_step), runs, failures, started)
    return feeder_runs, runs, per_step, failures


def record_term_yield(conn, run_id, runs, per_step, new_urls, started):
    """Per search term and site: how many postings it fetched and how many were new. Feeds the term report."""
    jobspy_stats = next((r["stats"] for r in runs if r["id"] == "jobspy"), {})
    if not jobspy_stats.get("terms"):
        return
    by_term = {}
    for o in per_step.get("jobspy", []):
        if canonical_url(o.get("url")) in new_urls and o.get("term"):
            by_term[o["term"]] = by_term.get(o["term"], 0) + 1
    for key, fetched in jobspy_stats["terms"].items():
        site, _, term = key.partition("|")
        conn.execute("INSERT INTO term_yield VALUES (?,?,?,?,?,?)", (run_id, term, site, fetched, 0, started.date().isoformat()))
    for term, n in by_term.items():
        conn.execute("UPDATE term_yield SET new_rows=? WHERE run_id=? AND term=? AND rowid=(SELECT MIN(rowid) FROM term_yield WHERE run_id=? AND term=?)", (n, run_id, term, run_id, term))
    conn.commit()


@dataclass
class Saved:
    merged: list
    new_rows: list
    known: int
    history_note: str
    dropped: dict  # rows the freshness gate refused: {"stale": n, "undated": n, "experience": n}
    expired: dict  # retention: {"expired": n, "kept_acted_on": n, "forgotten": n}


def save_results(args, started, per_step, runs, failures, xlsx_path):
    """Write the run to the database (a copy in a dry run), score each source's health and refresh the workbook."""
    run_id = store.start_run(None)
    if args.dry_run:
        conn = store.dry_run_connection()  # 'new' is computed against a copy; data/jobs.db is neither created nor changed
    else:
        store.backup_db(keep=(pipeline_cfg.section("retention") or {}).get("backups_kept"))
        conn = store.connect()
    history_note = None
    if conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0] == 0 and (ROOT / "data" / "scan-history.tsv").exists():
        rep = store.migrate_scan_history(conn, ROOT / "data" / "scan-history.tsv")
        history_note = f"imported scan-history.tsv: {rep['total']} rows"
    cfg = pipeline_cfg.load()
    merged, dropped = freshness.apply(merge(per_step), cfg.get("freshness"), cfg.get("max_min_experience_years", 0))
    new_rows, known = store.ingest(conn, merged, run_id)
    new_keys = {r["canonical_url"] for r in new_rows}
    new_urls = {u for r in new_rows for u in r["urls"]}
    store.ingest_rejected_tsv(conn, ROOT / "data" / "rejected.tsv")
    store.prune_rejected(conn, pipeline_cfg.load().get("rejected_log_days", 30))
    for r in runs:
        r["new"] = sum(1 for row in merged if r["id"] in row["steps"] and row["canonical_url"] in new_keys)
        r["duplicates"] = max(r["kept"] - r["new"], 0)
        r["health"], r["health_note"] = health.assess(r["fetched"], r["status"], store.history(conn, r["id"]))
        for f in failures:
            f.setdefault("class", health.classify_failure(f["message"]))
        store.record_source_run(conn, run_id, r["id"], started=started.isoformat(timespec="seconds"),
                                ended=datetime.now().isoformat(timespec="seconds"), status=r["status"], fetched=r["fetched"],
                                kept=r["kept"], new=r["new"], duplicates=r["duplicates"], errors=r["errors"],
                                error=r["note"] if r["status"] == "failed" else "", seconds=r["secs"], health=r["health"],
                                window_days=r.get("window_days"), dry_run=int(args.dry_run))
    store.record_failures(conn, run_id, failures)
    record_term_yield(conn, run_id, runs, per_step, new_urls, started)
    retention = cfg.get("retention") or {}
    expired = store.expire_jobs(conn, retention.get("job_ttl_days", 30), retention.get("tombstone_days", 365)) if retention else {}
    write_excel(xlsx_path, db_rows(conn, run_id), runs, failures, started)
    return Saved(merged, new_rows, known, history_note, dict(dropped), expired)


def announce(args, plan, started, new_rows):
    """After a real run: the Telegram ping, then the background slow lane. A dry run only says what would happen."""
    if new_rows and not args.dry_run:
        _sent, ping_note = notify_telegram.send_new(new_rows, started.strftime("%d %b %H:%M"))
        print(ping_note)
    if not args.slow and not args.no_slow and not plan.explicit:
        print(start_slow_lane() if not args.dry_run else "mine: a real run would now start the background slow lane (LinkedIn, Glassdoor)")


def print_report(args, plan, saved, feeder_runs, runs, failures, per_step, paths):
    xlsx_path, log_path, dedup_path = paths
    stats, multi = dedup_report(per_step, dedup_path)
    print(f"\n{len(saved.merged)} unique offers ({len(saved.new_rows)} new, {saved.known} already known) from {len(plan.steps)} step(s); "
          f"{len(failures)} failure/retry events")
    if saved.history_note:
        print(saved.history_note)
    if saved.expired.get("expired"):
        print(f"retention: {saved.expired['expired']} jobs unseen for {(pipeline_cfg.section('retention') or {}).get('job_ttl_days', 30)} days removed "
              f"({saved.expired['kept_acted_on']} you acted on kept, {saved.expired['forgotten']} old tombstones forgotten)")
    if saved.dropped:
        print("freshness gate dropped: " + ", ".join(f"{n} {why}" for why, n in sorted(saved.dropped.items())))
    print(health.summary_table([{"source": r["id"], "fetched": r["fetched"], "kept": r["kept"], "new": r["new"],
                                 "duplicates": r["duplicates"], "errors": r["errors"], "health": r["health"],
                                 "seconds": r["secs"]} for r in runs]))
    for fr in feeder_runs:
        if fr["status"] != "ok":
            print(f"  feeder {fr['id']}: {fr['status']} {fr['note']} (retried at the next run)")
    for r in runs:
        if r["health"] != health.OK or r["note"]:
            print(f"  {r['id']}: {r['status']} {r['health']} {r['health_note']} {r['note']}".rstrip())
    print(f"{multi} jobs were found by more than one source; collapsed per pair: "
          + (", ".join(f"{a}+{b} {n}" for (a, b), n in sorted(stats.items(), key=lambda kv: -kv[1])) or "none"))
    print(f"Excel: {xlsx_path}\nLog:   {log_path}\nDedup: {dedup_path}" + ("\n(dry run: data/jobs.db not changed)" if args.dry_run else f"\nDB:    {store.DB_PATH}"))


def main():
    args = build_parser().parse_args()
    if args.slow and args.slow_batches > 1 and not args.dry_run:
        return run_slow_batches(args.slow_batches, args.slow_gap_min)

    started = datetime.now()
    (OUT / "logs").mkdir(parents=True, exist_ok=True)
    log_path = OUT / "logs" / f"mine-{started:%Y%m%d-%H%M%S}.log"
    xlsx_path = OUT / f"mine-{started:%Y-%m-%d-%H%M%S}.xlsx"
    dedup_path = OUT / "logs" / f"dedup-{started:%Y%m%d-%H%M%S}.md"

    state = load_state()
    plan = plan_run(args, state, started, sys.argv[1:])
    for note in plan.notes:
        print(note)
    print(f"mine: {len(plan.steps)} step(s), windows {plan.windows if not args.days else f'{args.days}d (override)'}, "
          f"log {log_path.relative_to(ROOT)}, excel {xlsx_path.relative_to(ROOT)}")
    write_excel(xlsx_path, [], [], [], started)
    with log_path.open("w") as log:
        log.write(f"mine run {started.isoformat()} args={vars(args)}\n")
        feeder_runs, runs, per_step, failures = execute_plan(plan, args, state, log, xlsx_path, started)

    saved = save_results(args, started, per_step, runs, failures, xlsx_path)
    announce(args, plan, started, saved.new_rows)
    print_report(args, plan, saved, feeder_runs, runs, failures, per_step, (xlsx_path, log_path, dedup_path))
    return health.exit_code(runs)


if __name__ == "__main__":
    sys.exit(main())
