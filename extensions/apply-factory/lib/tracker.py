"""
Writes to career-ops' tracker the way career-ops requires: through its own scripts, never by editing applications.md.

  mark_applied   the application was submitted: set the existing row to Applied, or add a row through a tracker-addition
                 TSV and merge-tracker.mjs, then seed the follow-up date.
  queue          put the posting in data/pipeline.md so `/career-ops pipeline` runs the full A-F evaluation on it.
"""
from __future__ import annotations

import datetime
import re

from . import checks, config, nodecli


def _run(args: list[str]) -> tuple[bool, str]:
    rc, out, err = nodecli.run(args, timeout=60)
    return rc == 0, (out or err).strip()[:300]


def _row_number(candidate: dict) -> str | None:
    for k in ("num", "id", "#", "row"):
        if candidate.get(k) not in (None, ""):
            return str(candidate[k]).lstrip("0") or "0"
    return None


def mark_applied(url: str, company: str, title: str, resume_name: str = "") -> dict:
    note = "Applied via apply-factory" + (f"; CV {resume_name}" if resume_name else "")
    steps: list[str] = []

    report = checks.report_for(company, url)
    existing = None
    if report["status"] == "match":
        ok, msg = _run(["set-status.mjs", "--report", report["num"].lstrip("0") or "0", "Applied", "--note", note])
        steps.append(f"set-status --report {report['num']}: {'ok' if ok else msg}")
        existing = report["num"].lstrip("0") or "0" if ok else None
        if not ok:
            return {"ok": False, "steps": steps}
    else:
        dup = checks.duplicate(company, title, url)
        cand = next((_row_number(c) for c in dup.get("rows", []) if _row_number(c)), None)
        if cand:
            ok, msg = _run(["set-status.mjs", cand, "Applied", "--note", note])
            steps.append(f"set-status {cand}: {'ok' if ok else msg}")
            if not ok:
                return {"ok": False, "steps": steps}
            existing = cand

    if existing:
        num, action = existing, "updated"
    else:
        ok, out = _run(["reserve-report-num.mjs"])
        num = re.search(r"\d+", out).group(0) if ok and re.search(r"\d+", out) else None
        if not num:
            return {"ok": False, "steps": steps + [f"could not reserve a number: {out}"]}
        slug = re.sub(r"[^a-z0-9]+", "-", company.lower()).strip("-") or "company"
        tsv = config.CAREEROPS / "batch" / "tracker-additions" / f"{num}-{slug}.tsv"
        tsv.parent.mkdir(parents=True, exist_ok=True)
        clean = lambda s: re.sub(r"[\t\r\n]+", " ", s).strip()
        tsv.write_text("num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n"
                       f"{int(num)}\t{datetime.date.today().isoformat()}\t{clean(company)}\t{clean(title)}\tApplied\tN/A\t❌\t—\t{clean(note)}\t{clean(url)}\n")
        ok, msg = _run(["merge-tracker.mjs"])
        steps.append(f"merge-tracker: {'ok' if ok else msg}")
        _run(["reserve-report-num.mjs", "--release", num])
        if not ok:
            return {"ok": False, "steps": steps}
        action = "added"

    ok, msg = _run(["followup-seed.mjs", num.lstrip("0") or "0"])
    steps.append(f"followup-seed: {'ok' if ok else msg}")
    return {"ok": True, "action": action, "num": num, "steps": steps}


def queue(url: str, company: str, title: str) -> dict:
    path = config.CAREEROPS / "data" / "pipeline.md"
    text = path.read_text() if path.exists() else "# Pipeline — Pending URLs\n\n## Pending\n\n"
    if url in text:
        return {"ok": True, "queued": False, "reason": "already in the pipeline"}
    line = f"- [ ] {url} | {company} | {title}\n"
    if "## Pending" in text:
        head, _, rest = text.partition("## Pending\n")
        text = head + "## Pending\n" + line + rest
    else:
        text += "\n## Pending\n" + line
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(text)
    tmp.replace(path)
    return {"ok": True, "queued": True}
