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


def step_due(state, step_id, every_days, now=None):
    """True when the step has never succeeded or last succeeded `every_days` or more ago."""
    last = state.get(step_id)
    if not last:
        return True
    now = now or datetime.now()
    try:
        return (now - datetime.fromisoformat(last)).total_seconds() >= every_days * 86400
    except ValueError:
        return True


def build_steps(args):
    flags = ["--dry-run"] if args.dry_run else []
    steps = [
        {"id": "freehire", "file": "scan-freehire.mjs", "args": ["--days", str(args.days), "--max-pages", str(args.freehire_pages), *flags]},
        {"id": "internshala", "file": "scan-internshala.mjs", "args": ["--days", str(args.days + 1), "--max-pages", str(args.internshala_pages), *flags]},
        {"id": "jobspy", "file": "scan-jobspy.mjs", "args": ["--days", str(args.days), "--sites", args.sites, *flags]},
        # scan.mjs and scan-ats-full.mjs take a bare --json (receipt on stdout, no file path)
        {"id": "portals", "file": "scan.mjs", "bare_json": True, "args": ["--since", str(args.days), *flags]},
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
    by_url = {}
    for step, offers in per_step.items():
        for o in offers:
            hit = by_url.get(norm_url(o.get("url")))
            if hit:
                hit["steps"].add(step)
            else:
                by_url[norm_url(o.get("url"))] = {**o, "site": site_of(o), "steps": {step}}
    return list(by_url.values())


def write_excel(path, per_step, runs, failures, started):
    wb = Workbook()
    ws = wb.active
    ws.title = "Offers"
    ws.append(["Company", "Title", "Location", "Site", "Source", "Found by", "Link"])
    for o in sorted(merge(per_step), key=lambda x: (x["site"], str(x.get("company") or ""))):
        ws.append([o.get("company") or "", o.get("title") or "", o.get("location") or "",
                   o["site"], o.get("source") or "", ", ".join(sorted(o["steps"])), o.get("url") or ""])
        cell = ws.cell(row=ws.max_row, column=7)
        if cell.value:
            cell.hyperlink = cell.value
            cell.font = Font(color="0563C1", underline="single")
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    wr = wb.create_sheet("Runs")
    wr.append(["Step", "Status", "Seconds", "New offers", "Note"])
    for r in runs:
        wr.append([r["id"], r["status"], r["secs"], r["count"], r["note"]])

    wf = wb.create_sheet("Failures")
    wf.append(["Step", "Kind", "What", "Message"])
    for f in failures:
        wf.append([f["step"], f["kind"], f["label"], f["message"]])

    for sheet, widths in ((ws, (28, 50, 28, 12, 18, 16, 60)), (wr, (14, 10, 10, 12, 60)), (wf, (14, 10, 40, 90))):
        for i, w in enumerate(widths):
            sheet.column_dimensions[chr(65 + i)].width = w
        for c in sheet[1]:
            c.font = Font(bold=True)
    wb.properties.title = f"mine run {started:%Y-%m-%d %H:%M}"
    tmp = path.with_suffix(".xlsx.tmp")
    wb.save(tmp)
    tmp.replace(path)


PLUS = re.compile(r"^\s+\+ (.+?) \| (.+?) \| (.*?)(?: \[(?:Trust|BLACKLISTED).*)?$")
TICK = re.compile(r"scan: (\d+)/(\d+)")
ATS_TICK = re.compile(r"(\d+)\s*/\s*(\d+)")


def parse_bare_line(step_id, line, scraped, bar):
    """Pull offers and progress out of scan.mjs / scan-ats-full.mjs output. Returns the stdout receipt if this line is one."""
    text = line.lstrip()
    if text.startswith("{"):
        start = text.find("{")
        try:
            ev = json.loads(text[start:])
        except json.JSONDecodeError:
            return None
        if ev.get("kind") == "offer" and ev.get("url"):
            scraped.append({"company": ev.get("company"), "title": ev.get("title"), "location": ev.get("location"),
                            "url": ev["url"], "source": ev.get("source") or "ats"})
            bar.set_postfix_str(f"{len(scraped)} offers", refresh=True)
            return None
        if "added_urls" in ev or "postingsKept" in ev:
            return ev
        return None
    if step_id == "portals":
        m = PLUS.match(line)
        if m:
            scraped.append({"company": m.group(1), "title": m.group(2), "location": m.group(3), "source": "portals"})
        t = TICK.search(line)
        if t:
            bar.total, bar.n = max(int(t.group(2)), 1), min(int(t.group(1)), int(t.group(2)))
            bar.refresh()
    elif step_id == "ats":
        t = ATS_TICK.search(line)
        if t and int(t.group(2)) > 0:
            bar.total, bar.n = int(t.group(2)), min(int(t.group(1)), int(t.group(2)))
            bar.set_postfix_str(f"{len(scraped)} offers", refresh=True)
    return None


def finish_bare(step_id, scraped, receipt):
    if step_id == "portals":
        urls = (receipt or {}).get("added_urls") or []
        # offers are printed in the same order as added_urls; only trust the pairing when counts agree
        if len(urls) == len(scraped):
            return [{**o, "url": u} for o, u in zip(scraped, urls)]
        return [{**o, "url": u} for o, u in zip(scraped, urls)] + [o for o in scraped[len(urls):]]
    return scraped


def run_step(step, log, failures, position):
    """Run one scanner, drive its bar, return (offers, status dict)."""
    json_path = Path(tempfile.mkdtemp(prefix="mine-")) / f"{step['id']}.json"
    cmd = ["node", str(ROOT / step["file"]), *step["args"], *(["--json"] if step.get("bare_json") else ["--json", str(json_path)])]
    env = {**os.environ, "MINE_PROGRESS": "1"}
    log.write(f"\n===== {step['id']}: {' '.join(cmd)}\n")
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, bufsize=1)
    bar = tqdm(total=1, desc=step["id"], position=position, leave=True, unit="call",
               bar_format="{desc:<12} {percentage:3.0f}%|{bar:24}| {n_fmt}/{total_fmt} [{elapsed}] {postfix}")
    fails = retries = 0
    tail = []
    scraped, receipt = [], None
    for raw in proc.stdout:
        line = raw.rstrip("\n")
        log.write(line + "\n")
        log.flush()
        m = LINE.match(line)
        if not m:
            tail = (tail + [line])[-6:]
            if step.get("bare_json"):
                receipt = parse_bare_line(step["id"], line, scraped, bar) or receipt
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
    if step.get("bare_json"):
        offers = finish_bare(step["id"], scraped, receipt)
    elif json_path.exists():
        try:
            offers = json.loads(json_path.read_text())
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
    if code != 0:
        status, note = "failed", f"exit {code}: " + " / ".join(tail[-3:])
    elif fails:
        status, note = "partial", f"{fails} failed calls, {retries} retries"
    else:
        status, note = "ok", f"{retries} retries" if retries else ""
    log.write(f"===== {step['id']} done: {status}, {len(offers)} offers, {secs}s\n")
    return offers, {"id": step["id"], "status": status, "secs": secs, "count": len(offers), "note": note}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=3)
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
    steps = build_steps(args)
    state = load_state()
    explicit_steps = any(a == "--steps" or a.startswith("--steps=") for a in sys.argv[1:])
    if not explicit_steps and not step_due(state, "ats", args.ats_every):
        steps = [s for s in steps if s["id"] != "ats"]
        print(f"mine: ats step not due (last run {state['ats'][:10]}, every {args.ats_every} days); pass --steps to force it")
    print(f"mine: {len(steps)} step(s), log {log_path.relative_to(ROOT)}, excel {xlsx_path.relative_to(ROOT)}")
    write_excel(xlsx_path, per_step, runs, failures, started)
    with log_path.open("w") as log:
        log.write(f"mine run {started.isoformat()} args={vars(args)}\n")
        for i, step in enumerate(steps):
            offers, status = run_step(step, log, failures, i)
            per_step[step["id"]] = offers
            runs.append(status)
            if status["status"] in ("ok", "partial") and not args.dry_run:
                state[step["id"]] = datetime.now().isoformat(timespec="seconds")
                save_state(state)
            write_excel(xlsx_path, per_step, runs, failures, started)
    total = len(merge(per_step))
    print(f"\n{total} unique offers from {len(steps)} step(s); {len(failures)} failure/retry events")
    for r in runs:
        print(f"  {r['id']:<12} {r['status']:<8} {r['count']:>4} offers  {r['secs']}s  {r['note']}")
    print(f"Excel: {xlsx_path}\nLog:   {log_path}")
    return 0 if all(r["status"] != "failed" for r in runs) else 1


if __name__ == "__main__":
    sys.exit(main())
