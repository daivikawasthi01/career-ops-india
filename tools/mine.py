#!/usr/bin/env python3
"""Front end for the India entry-level scanners.

Runs each Node scanner as a subprocess with MINE_PROGRESS=1, shows a tqdm bar
from its "@@PROGRESS done/total label" lines, keeps a full log, and rewrites the
Excel workbook after every step so a crash never loses finished work.

  tools/.venv-jobspy/bin/python tools/mine.py --days 3 --sites naukri,indeed,linkedin
  tools/.venv-jobspy/bin/python tools/mine.py --dry-run

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
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from openpyxl import Workbook
from openpyxl.styles import Font
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dedup  # noqa: E402
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


LOW_COVERAGE = 0.8      # below this share of boards read, the step comes back sooner
VERY_LOW_COVERAGE = 0.5


def _entry(state, step_id):
    """State entry as (timestamp, coverage). Old files stored a bare timestamp string."""
    raw = state.get(step_id)
    if isinstance(raw, dict):
        return raw.get("at"), raw.get("coverage")
    return raw, None


def due_after_days(every_days, coverage):
    """A run that read most boards waits the full interval; a thin run comes back sooner."""
    if coverage is None or coverage >= LOW_COVERAGE:
        return every_days
    return min(every_days, 1 if coverage < VERY_LOW_COVERAGE else 3)


def step_due(state, step_id, every_days, now=None):
    """True when the step has never succeeded, or last succeeded long enough ago for its coverage."""
    last, coverage = _entry(state, step_id)
    if not last:
        return True
    now = now or datetime.now()
    try:
        return (now - datetime.fromisoformat(last)).total_seconds() >= due_after_days(every_days, coverage) * 86400
    except ValueError:
        return True


def select_steps(steps, state, explicit, ats_every, now=None):
    """Drop the ats step from a default run when it is not due. Returns (steps, notes)."""
    if explicit or step_due(state, "ats", ats_every, now):
        return steps, []
    last, coverage = _entry(state, "ats")
    why = f"last run {str(last)[:10]}" + (f", {coverage:.0%} of boards read" if coverage is not None else "")
    kept = [s for s in steps if s["id"] != "ats"]
    return kept, [f"mine: ats step not due ({why}); pass --steps to force it"]


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


def build_steps(args, windows=None):
    flags = ["--dry-run"] if args.dry_run else []
    w = {k: (windows or {}).get(k, args.days or 3) for k in ("freehire", "internshala", "jobspy", "portals")}
    steps = [
        {"id": "freehire", "file": "scan-freehire.mjs", "args": ["--days", str(w["freehire"]), "--max-pages", str(args.freehire_pages), *flags]},
        {"id": "internshala", "file": "scan-internshala.mjs", "args": ["--days", str(w["internshala"] + 1), "--max-pages", str(args.internshala_pages), *flags]},
        {"id": "jobspy", "file": "scan-jobspy.mjs", "args": ["--days", str(w["jobspy"]), "--sites", args.sites, *flags]},
        # scan.mjs and scan-ats-full.mjs take a bare --json (receipt on stdout, no file path)
        {"id": "portals", "file": "scan.mjs", "bare_json": True, "args": ["--since", str(w["portals"]), *flags]},
        {"id": "ats", "file": "scan-ats-full.mjs", "bare_json": True,
         "args": ["--since", str(args.ats_days), "--ats", args.ats_sources, *(["--limit", str(args.ats_limit)] if args.ats_limit else []), *flags]},
    ]
    wanted = [s.strip() for s in args.steps.split(",")]
    return [s for s in steps if s["id"] in wanted]


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
    for key in ("linkedin", "naukri", "indeed", "internshala", "wellfound", "instahyre", "shine"):
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=None, help="override the scan window; default is since each step's last success plus a day of overlap (config window:)")
    ap.add_argument("--sites", default="naukri,indeed,linkedin")
    ap.add_argument("--steps", default="freehire,internshala,jobspy,portals,ats", help="comma list of steps to run")
    ap.add_argument("--ats-sources", default="greenhouse,lever,ashby", help="ATS directories for the reverse sweep")
    ap.add_argument("--ats-limit", type=int, default=0, help="max companies per ATS (0 = all)")
    ap.add_argument("--ats-days", type=int, default=14, help="posting window for the ats step (it runs weekly, so it needs a wider window than --days)")
    ap.add_argument("--ats-every", type=int, default=7, help="days between ats runs in a default run; --steps ats always runs it. The sweep is slow and low yield (a 30 day sample of 300 Greenhouse boards found 2 India roles)")
    ap.add_argument("--freehire-pages", type=int, default=6, help="pages of 100 per freehire query")
    ap.add_argument("--internshala-pages", type=int, default=5, help="result pages per Internshala category")
    ap.add_argument("--dry-run", action="store_true", help="scanners print matches and write nothing to the pipeline")
    args = ap.parse_args()

    started = datetime.now()
    (OUT / "logs").mkdir(parents=True, exist_ok=True)
    log_path = OUT / "logs" / f"mine-{started:%Y%m%d-%H%M%S}.log"
    xlsx_path = OUT / f"mine-{started:%Y-%m-%d-%H%M%S}.xlsx"

    per_step, runs, failures = {}, [], []
    state = load_state()
    explicit = steps_given(sys.argv[1:])
    windows = {sid: health.window_days((_entry(state, sid)[0]), args.days, started) for sid in ("freehire", "internshala", "jobspy", "portals")}
    args.sites, site_notes = select_sites(args.sites, state, explicit, started)
    steps = [x for x in build_steps(args, windows) if not (x["id"] == "jobspy" and not args.sites)]
    steps, notes = select_steps(steps, state, explicit, args.ats_every)
    for note in notes + site_notes:
        print(note)
    print(f"mine: {len(steps)} step(s), windows {windows if not args.days else f'{args.days}d (override)'}, "
          f"log {log_path.relative_to(ROOT)}, excel {xlsx_path.relative_to(ROOT)}")
    write_excel(xlsx_path, [], [], [], started)
    with log_path.open("w") as log:
        log.write(f"mine run {started.isoformat()} args={vars(args)}\n")
        for i, step in enumerate(steps):
            offers, status = run_step(step, log, failures, i)
            status["window_days"] = windows.get(step["id"])
            per_step[step["id"]] = offers
            runs.append(status)
            if record_run(state, status, args.dry_run):
                if step["id"] == "jobspy" and "linkedin" in args.sites.split(","):
                    state["linkedin"] = state[step["id"]]
                save_state(state)
            write_excel(xlsx_path, merge(per_step), runs, failures, started)

    # ---- store, health, summary ----
    run_id = store.start_run(None)
    if args.dry_run:
        conn = store.dry_run_connection()  # 'new' is computed against a copy; data/jobs.db is neither created nor changed
    else:
        store.backup_db()
        conn = store.connect()
    history_note = None
    if conn.execute("SELECT COUNT(*) FROM seen").fetchone()[0] == 0 and (ROOT / "data" / "scan-history.tsv").exists():
        rep = store.migrate_scan_history(conn, ROOT / "data" / "scan-history.tsv")
        history_note = f"imported scan-history.tsv: {rep['total']} rows"
    merged = merge(per_step)
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
    jobspy_stats = next((r["stats"] for r in runs if r["id"] == "jobspy"), {})
    if jobspy_stats.get("terms"):
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
    write_excel(xlsx_path, db_rows(conn, run_id), runs, failures, started)
    dedup_path = OUT / "logs" / f"dedup-{started:%Y%m%d-%H%M%S}.md"
    stats, multi = dedup_report(per_step, dedup_path)

    print(f"\n{len(merged)} unique offers ({len(new_rows)} new, {known} already known) from {len(steps)} step(s); "
          f"{len(failures)} failure/retry events")
    if history_note:
        print(history_note)
    print(health.summary_table([{"source": r["id"], "fetched": r["fetched"], "kept": r["kept"], "new": r["new"],
                                 "duplicates": r["duplicates"], "errors": r["errors"], "health": r["health"],
                                 "seconds": r["secs"]} for r in runs]))
    for r in runs:
        if r["health"] != health.OK or r["note"]:
            print(f"  {r['id']}: {r['status']} {r['health']} {r['health_note']} {r['note']}".rstrip())
    print(f"{multi} jobs were found by more than one source; collapsed per pair: "
          + (", ".join(f"{a}+{b} {n}" for (a, b), n in sorted(stats.items(), key=lambda kv: -kv[1])) or "none"))
    print(f"Excel: {xlsx_path}\nLog:   {log_path}\nDedup: {dedup_path}" + ("\n(dry run: data/jobs.db not changed)" if args.dry_run else f"\nDB:    {store.DB_PATH}"))
    return health.exit_code(runs)


def select_sites(sites, state, explicit, now=None):
    """Drop LinkedIn from a default jobspy run when it is not due (config jobspy.run_every_days.linkedin)."""
    every = (pipeline_cfg.section("jobspy").get("run_every_days") or {}).get("linkedin")
    names = [x.strip() for x in sites.split(",") if x.strip()]
    if explicit or not every or "linkedin" not in names or step_due(state, "linkedin", every, now):
        return sites, []
    kept = [x for x in names if x != "linkedin"]
    return ",".join(kept), [f"mine: linkedin not due (runs every {every} days); pass --steps to force it"]


if __name__ == "__main__":
    sys.exit(main())
