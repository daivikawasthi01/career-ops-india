#!/usr/bin/env python3
"""Weekly report as markdown, from data/jobs.db (Phase 9.3). It PROPOSES changes; it applies none (Phase 9.4),
except `--apply-boards`, which appends newly discovered company boards to portals.yml after a backup.

  python3 tools/weekly_report.py                 # prints and writes output/weekly-YYYY-MM-DD.md
  python3 tools/weekly_report.py --days 14
  python3 tools/weekly_report.py --apply-boards  # add the boards listed in the report to portals.yml (review them first)
"""
import argparse
import json
import re
import shutil
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from itertools import combinations
from pathlib import Path

import pipeline_cfg
import store
import term_report
from audit_missed import ATS_TOKEN, node
from canonical import company_key

ROOT = Path(__file__).resolve().parent.parent
ENTRY_WORDS = re.compile(r"\b(intern|internship|fresher|graduate|trainee|junior|entry|associate|campus|apprentice)\b", re.I)


def jobs_in_window(conn, days, today=None):
    since = ((today or date.today()) - timedelta(days=days)).isoformat()
    out = []
    for r in conn.execute("SELECT * FROM jobs WHERE first_seen >= ?", (since,)):
        d = dict(r)
        d["found_by"] = json.loads(d["found_by"] or "[]")
        d["first_seen_by"] = json.loads(d["first_seen_by"] or "{}")
        out.append(d)
    return out


def per_source(jobs):
    """unique finds (only this source found it), total found, precision = (interested+applied)/found."""
    sources = sorted({s for j in jobs for s in j["found_by"]})
    rows = []
    for s in sources:
        mine = [j for j in jobs if s in j["found_by"]]
        unique = [j for j in mine if j["found_by"] == [s]]
        good = sum(j["status"] in ("interested", "applied") for j in mine)
        judged = sum(j["status"] != "new" for j in mine)
        rows.append({"source": s, "found": len(mine), "unique": len(unique), "good": good, "judged": judged,
                     "precision": (good / len(mine)) if mine else 0.0})
    return rows


def lead_times(jobs):
    """Average days a source saw a job before the earliest OTHER source (jobs seen by 2+ sources only)."""
    acc = {}
    for j in jobs:
        fs = j["first_seen_by"]
        if len(fs) < 2:
            continue
        for s, d in fs.items():
            others = [datetime.fromisoformat(v) for k, v in fs.items() if k != s]
            lead = (min(others) - datetime.fromisoformat(d)).days
            acc.setdefault(s, []).append(lead)
    return {s: sum(v) / len(v) for s, v in acc.items()}


def overlap_and_coverage(jobs):
    """Pairwise overlap and a Lincoln-Petersen estimate N = n1*n2/m. Assumes the two sources find jobs
    independently, which they do not (both favour popular companies), so treat it as a rough guide only."""
    rows = []
    for a, b in combinations(sorted({s for j in jobs for s in j["found_by"]}), 2):
        na = sum(a in j["found_by"] for j in jobs)
        nb = sum(b in j["found_by"] for j in jobs)
        m = sum(a in j["found_by"] and b in j["found_by"] for j in jobs)
        rows.append({"pair": (a, b), "a": na, "b": nb, "both": m, "estimate": round(na * nb / m) if m else None})
    return rows


def false_negative_candidates(conn, days, limit=20, today=None):
    since = ((today or date.today()) - timedelta(days=days)).isoformat()
    rows = conn.execute("SELECT title, company, source, url, reject_reason FROM rejected WHERE seen_at >= ? "
                        "AND (reject_reason IN ('title','batch_year') OR reject_reason LIKE 'experience%')", (since,)).fetchall()
    return [dict(r) for r in rows if r["title"] and ENTRY_WORDS.search(r["title"])][:limit]


def discovered_boards(conn, tracked_keys):
    """greenhouse/lever/ashby tokens seen in job URLs whose company is not a tracked board: [(slug, url)]."""
    found = {}
    for r in conn.execute("SELECT url, urls FROM jobs"):
        for u in [r["url"], *json.loads(r["urls"] or "[]")]:
            for pat, fmt in ATS_TOKEN:
                m = pat.search(u or "")
                if m and company_key(m.group(1)) not in tracked_keys:
                    found[m.group(1).lower()] = fmt.format(m.group(1))
    return sorted(found.items())


def board_entries(boards):
    return "".join(f"\n  - name: {slug}\n    careers_url: {url}\n    source: discovered-from-url\n" for slug, url in boards)


def insert_boards(portals_text, boards):
    """Add entries at the end of tracked_companies (before the next top-level key). Returns new text."""
    lines = portals_text.split("\n")
    start = next((i for i, l in enumerate(lines) if l.startswith("tracked_companies:")), None)
    if start is None:
        raise ValueError("portals.yml has no tracked_companies: block")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"^[A-Za-z_]+:", lines[i])), len(lines))
    while end > start + 1 and not lines[end - 1].strip():
        end -= 1
    new = board_entries(boards).rstrip("\n").split("\n")
    return "\n".join(lines[:end] + new + lines[end:])


def render(conn, days, boards, today=None):
    jobs = jobs_in_window(conn, days, today)
    md = [f"# Weekly report, last {days} days ({len(jobs)} new jobs)", ""]
    md += ["## Per source", "", "| source | found | unique | judged | interested+applied | precision |", "|---|---|---|---|---|---|"]
    for r in per_source(jobs):
        md.append(f"| {r['source']} | {r['found']} | {r['unique']} | {r['judged']} | {r['good']} | {r['precision']:.0%} |")
    md += ["", "Precision counts only rows you marked; unmarked rows count as not good, so it rises as you label more.", ""]
    lt = lead_times(jobs)
    md += ["## Lead time (days a source saw a job before the first other source)", ""]
    md += [f"- {s}: {v:+.1f}" for s, v in sorted(lt.items(), key=lambda kv: -kv[1])] or ["- no job was found by two sources yet"]
    md += ["", "## Overlap and rough coverage", ""]
    for o in overlap_and_coverage(jobs):
        est = f"about {o['estimate']} jobs exist that these two could find" if o["estimate"] else "no overlap, cannot estimate"
        md.append(f"- {o['pair'][0]} ({o['a']}) and {o['pair'][1]} ({o['b']}): {o['both']} in common; {est}")
    md += ["", "These estimates assume the two sources find jobs independently. They do not (both favour popular companies and "
           "recent postings), so the real total is higher than shown. Use them as a guide, not a measurement.", ""]
    y = term_report.term_yield(conn, days, today)
    md += ["## Search-term yield", ""]
    md += [f"- {t}: {v['new']} new, {v['fetched']} fetched" for t, v in sorted(y.items(), key=lambda kv: -kv[1]["new"])] or ["- no jobspy run in the window"]
    md += ["", "Terms with no new rows (report only): " + (", ".join(term_report.silent_terms(conn, days, today)) or "none"), ""]
    fn = false_negative_candidates(conn, days, today=today)
    md += ["## Rejected titles that look like entry-level roles (skim for false negatives)", ""]
    md += [f"- [{r['reject_reason']}] {r['title']} | {r['company']} | {r['source']}" for r in fn] or ["- none"]
    md += ["", "## Proposed changes (nothing is applied)", ""]
    if fn:
        words = Counter(w.lower() for r in fn for w in ENTRY_WORDS.findall(r["title"]))
        md += ["`config/pipeline.yml`: if the rejected titles above are real roles, loosen the rule that dropped them (see "
               "`tools/audit_missed.py` for the rule behind one title), then add them to `tests/titles.golden.tsv`. "
               f"Entry-level words in the rejected set: {dict(words)}.", ""]
    else:
        md += ["`config/pipeline.yml`: no change proposed.", ""]
    if boards:
        md += ["`portals.yml`: new boards seen in job URLs. Review, then run `tools/weekly_report.py --apply-boards`:", "", "```diff"]
        md += [f"+  - name: {slug}\n+    careers_url: {url}\n+    source: discovered-from-url" for slug, url in boards]
        md += ["```", ""]
    else:
        md += ["`portals.yml`: no new boards discovered.", ""]
    return "\n".join(md)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--apply-boards", action="store_true")
    ap.add_argument("--portals", default=str(ROOT / "portals.yml"))
    a = ap.parse_args()
    conn = store.connect()
    tracked = {company_key(t["name"]) for t in (node("tracked") or [])}
    boards = discovered_boards(conn, tracked)
    text = render(conn, a.days, boards)
    out = ROOT / "output" / f"weekly-{date.today()}.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(text)
    print(f"\nWritten: {out}")
    if a.apply_boards:
        if not boards:
            print("No new boards to add.")
            return 0
        p = Path(a.portals)
        backup = p.with_name(f"{p.name}.bak-{datetime.now():%Y%m%d-%H%M%S}")
        shutil.copy2(p, backup)
        store.atomic_write(p, insert_boards(p.read_text(), boards))
        print(f"Added {len(boards)} board(s) to {p}. Backup: {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
