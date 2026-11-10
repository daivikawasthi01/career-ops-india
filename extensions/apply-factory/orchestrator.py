#!/usr/bin/env python3
"""
apply-factory orchestrator (extension inside career-ops).

Commands:
  ./orchestrator.py init                 — create KB
  ./orchestrator.py serve                — local API for the browser extension
  ./orchestrator.py retry                — re-run fields whose learning failed
  ./orchestrator.py kb list|get|set      — inspect / seed KB
"""
from __future__ import annotations
import argparse
import json
import sys
import urllib.error
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parent          # extensions/apply-factory/
_CAREEROPS = _ROOT.parent.parent                  # career-ops/
sys.path.insert(0, str(_ROOT))

from lib import config, db, knowledge
from lib.report_parser import parse_section_g
from learner import learn as learner


def _cfg() -> dict:
    return config.load()


def _report_path(slug: str) -> Path:
    return _CAREEROPS / "reports" / f"{slug}.md"


# ---------- Commands ----------

def cmd_serve(args):
    import server
    server.run(port=args.port, reset_pair=args.reset_pair)


def cmd_doctor(args):
    """One screen that says what is ready and what to install, so setup is a checklist rather than guesswork."""
    import shutil
    import urllib.request
    from lib import cv_store, llm, resume

    rows = []

    def row(name, ok, fix=""):
        rows.append((name, ok, fix))

    for tool, fix in (("node", "brew install node"), ("tectonic", "brew install tectonic"), ("pdftotext", "brew install poppler"),
                      ("pdftoppm", "brew install poppler"), ("pdftohtml", "brew install poppler")):
        row(tool, bool(shutil.which(tool)), fix)
    st = llm.status()
    row("ollama running", st["ok"] or "error" not in st, "brew services start ollama")
    row(f"chat model ({_cfg()['llm']['model']})", st.get("chat_model") == _cfg()["llm"]["model"], f"ollama pull {_cfg()['llm']['model']}")
    row(f"embedding model ({_cfg()['llm']['embed_model']})", bool(st.get("embeddings")), f"ollama pull {_cfg()['llm']['embed_model']}")
    for r in resume.status():
        row(f"{r['label']} pdf ({r['file']})", r["exists"] or r["uses_default"], f"put the PDF in output/resumes/ or add it in the panel" if not r["exists"] else "")
    for s_ in cv_store.slots():
        if s_["kind"] == "default":
            row("default CV tex", s_["tex"], "open the CV studio and use Import PDF")
            row("default CV tex confirmed by you", bool(s_["confirmed"]), "open the studio, check the preview, press Publish")
    row("facts.yml", (_ROOT / "facts.yml").exists(), "create facts.yml (see README)")
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{_cfg()['server']['port']}/status", timeout=2)
    except urllib.error.HTTPError:
        up = True  # a 401 means the server answered and is waiting for the extension's token
    except Exception:
        up = False
    else:
        up = True
    row("server listening", up, "orchestrator.py serve  (or: install-service --load)")
    for name, ok, fix in rows:
        print(f"{'OK     ' if ok else 'MISSING'}  {name}" + (f"   -> {fix}" if not ok and fix else ""))
    print(f"\n{sum(1 for _, ok, _ in rows if ok)}/{len(rows)} ready")


def cmd_service(args):
    from lib import service
    print(service.uninstall() if args.remove else service.install(args.load))


def cmd_retry(args):
    db_path = str(_ROOT / _cfg()["paths"]["kb_db"])
    print(learner.retry_pending(db_path))


def cmd_init(args):
    cfg = _cfg()
    db_path = _ROOT / cfg["paths"]["kb_db"]
    db.init(str(db_path), str(_ROOT / "schema.sql"))
    print(f"initialized {db_path}")


# ---------- LinkedIn ----------

def cmd_linkedin_url(args):
    """Print the LinkedIn search URL for manual browsing."""
    from urllib.parse import urlencode

    tpr_map = {
        "past-24h": "r86400", "past-week": "r604800",
        "past-month": "r2592000", "any": "",
    }
    remote_map = {"onsite": "1", "remote": "2", "hybrid": "3", "any": ""}
    exp_map = {
        "entry": "2", "associate": "3", "mid-senior": "4",
        "director": "5", "any": "",
    }

    params = {"keywords": args.query}
    tpr = tpr_map.get(args.date_posted, "")
    if tpr:
        params["f_TPR"] = tpr
    if not args.all:
        params["f_AL"] = "true"
    remote = remote_map.get(args.remote, "")
    if remote:
        params["f_WT"] = remote
    exp = exp_map.get(args.experience, "")
    if exp:
        params["f_E"] = exp
    if args.location:
        params["location"] = args.location

    url = "https://www.linkedin.com/jobs/search/?" + urlencode(params)
    print(url)
    print()
    print("Open in your browser. When you find jobs to add:")
    print("  /career-ops linkedin add <url1> <url2> ...")


def cmd_linkedin_add(args):
    """Add one or more LinkedIn job URLs to the inbox manually."""
    from stages import linkedin as ls

    inbox_path = _ROOT / "data" / "linkedin-inbox.json"
    inbox_path.parent.mkdir(exist_ok=True)

    existing = json.loads(inbox_path.read_text()) if inbox_path.exists() else []
    seen = {j["url"] for j in existing}

    added, skipped, needs_info = [], [], []

    for url in args.urls:
        url = url.strip()
        if not url:
            continue
        if url in seen:
            skipped.append(url)
            continue

        # If --company and --role given AND we have one URL, use those directly.
        # Otherwise try to fetch metadata from LinkedIn's og: tags.
        if args.company and args.role and len(args.urls) == 1:
            company, role = args.company, args.role
            jd_text = ""
            if args.jd_file:
                jd_text = Path(args.jd_file).read_text()
        else:
            meta = _fetch_linkedin_meta(url)
            if not meta:
                needs_info.append(url)
                continue
            company = meta.get("company", "")
            role = meta.get("role", "")
            jd_text = meta.get("jd_text", "")

        if not company or not role:
            needs_info.append(url)
            continue

        entry = {
            "slug": ls._slug(company, role),
            "company": company, "role": role,
            "url": url, "location": "",
            "easy_apply": False,  # unknown from URL alone
            "jd_text": jd_text, "posted_at": "",
            "source": "linkedin-manual",
            "scraped_at": __import__("datetime").datetime.now().isoformat(),
            "status": "inbox",
        }
        existing.append(entry)
        seen.add(url)
        added.append(entry)

    inbox_path.write_text(json.dumps(existing, indent=2))

    print(f"Added: {len(added)}")
    for a in added:
        print(f"  ✓ {a['company']:30s}— {a['role']}")
    if skipped:
        print(f"Already in inbox: {len(skipped)}")
    if needs_info:
        print(f"Need company/role: {len(needs_info)}")
        for u in needs_info:
            print(f"  ✗ {u}")
        print()
        print("For each, rerun with:")
        print(f"  /career-ops linkedin add <url> --company \"X\" --role \"Y\"")


def _fetch_linkedin_meta(url: str) -> dict | None:
    """
    Try to extract company + role from LinkedIn's public OpenGraph tags.
    LinkedIn job pages are semi-public — og:title usually holds the role,
    og:site_name and og:description often reveal the company.
    Returns None if the fetch or parse fails.
    """
    try:
        import urllib.request
        import re
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; career-ops)"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        def og(prop):
            m = re.search(
                rf'<meta[^>]+property=["\']og:{prop}["\'][^>]+content=["\']([^"\']+)',
                html,
            )
            return m.group(1) if m else None

        title = og("title") or ""
        desc = og("description") or ""

        # LinkedIn title format: "Company hiring Role in Location | LinkedIn"
        m = re.match(r"^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+|$|\s*\|)", title)
        if m:
            return {
                "company": m.group(1).strip(),
                "role": m.group(2).strip(),
                "jd_text": desc[:2000],
            }
        # Fallback: title as role, empty company
        return {"company": "", "role": title, "jd_text": desc[:2000]}
    except Exception:
        return None


# ---------- KB Review ----------

def cmd_kb_review(args):
    cfg = _cfg()
    db_path = str(_ROOT / cfg["paths"]["kb_db"])
    with db.tx(db_path) as conn:
        rows = conn.execute("""
            SELECT e.intent_key, e.answer, e.answer_type, e.source, e.created_at,
                   (SELECT question_text FROM kb_question_variants v
                    WHERE v.intent_key = e.intent_key LIMIT 1) AS example_q
            FROM kb_entries e
            WHERE e.seen_count = 1
              AND e.source IN ('manual', 'llm', 'corrected')
            ORDER BY e.created_at DESC
        """).fetchall()

        if not rows:
            print("No unconfirmed entries. KB is clean.")
            return

        print(f"Unconfirmed KB entries (seen once, never reinforced): {len(rows)}\n")
        for i, r in enumerate(rows, 1):
            age = r["created_at"] or "unknown"
            q = r["example_q"] or "(no question recorded)"
            print(f"{i:3d}. {r['intent_key']:35s} = {r['answer'][:40]!r:42s}")
            print(f"     learned {age} from: {q!r}")
            print()

        print(f"Actions:")
        print(f"  /career-ops kb-approve <intent_key>   — reinforce, seen_count += 1")
        print(f"  /career-ops kb set <intent_key> \"<value>\"  — correct")
        print(f"  /career-ops kb-delete <intent_key>    — remove from KB")


def cmd_kb_approve(args):
    cfg = _cfg()
    db_path = str(_ROOT / cfg["paths"]["kb_db"])
    with db.tx(db_path) as conn:
        row = knowledge.lookup_by_intent(conn, args.key)
        if not row:
            sys.exit(f"unknown intent_key: {args.key}")
        conn.execute("""
            UPDATE kb_entries
            SET seen_count = seen_count + 1,
                confidence = MIN(1.0, confidence + 0.1),
                last_seen = CURRENT_TIMESTAMP
            WHERE intent_key = ?
        """, (args.key,))
        conn.execute("""
            INSERT INTO learning_events
                (intent_key, question_text, old_answer, new_answer, event_type)
            VALUES (?, '(kb-review approved)', ?, ?, 'reinforced')
        """, (args.key, row["answer"], row["answer"]))
        print(f"approved: {args.key} = {row['answer']!r}")


def cmd_kb_delete(args):
    cfg = _cfg()
    db_path = str(_ROOT / cfg["paths"]["kb_db"])
    with db.tx(db_path) as conn:
        row = knowledge.lookup_by_intent(conn, args.key)
        if not row:
            sys.exit(f"unknown intent_key: {args.key}")
        conn.execute("DELETE FROM kb_question_variants WHERE intent_key = ?", (args.key,))
        conn.execute("DELETE FROM kb_entries WHERE intent_key = ?", (args.key,))
        conn.execute("""
            INSERT INTO learning_events
                (intent_key, question_text, old_answer, new_answer, event_type)
            VALUES (?, '(kb-review deleted)', ?, '', 'deleted')
        """, (args.key, row["answer"]))
        print(f"deleted: {args.key} (was {row['answer']!r})")


# ---------- Briefing ----------

def cmd_briefing(args):
    cfg = _cfg()
    db_path = str(_ROOT / cfg["paths"]["kb_db"])
    from datetime import datetime, timedelta, timezone

    print(f"=== BRIEFING — {datetime.now().date()} ===\n")

    # NEW: LinkedIn inbox jobs staged in last 24h
    inbox = _ROOT / "data" / "linkedin-inbox.json"
    if inbox.exists():
        jobs = json.loads(inbox.read_text())
        cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        recent = [j for j in jobs if j.get("scraped_at", "") > cutoff][:5]
        if recent:
            print("NEW (linkedin, last 24h):")
            for j in recent:
                ea = " [EA]" if j.get("easy_apply") else ""
                print(f"  {j['role']:40s}— {j['company']:25s}{ea}")
            print()

    # READY: reports with a Section G (tailored but user hasn't applied yet)
    reports_dir = _CAREEROPS / "reports"
    if reports_dir.exists():
        ready = []
        for r in sorted(reports_dir.glob("*.md"), key=lambda p: -p.stat().st_mtime)[:20]:
            try:
                if parse_section_g(str(r)):
                    ready.append(r.stem)
            except Exception:
                pass
            if len(ready) >= 5:
                break
        if ready:
            print("READY TO APPLY (Section G exists):")
            for r in ready:
                print(f"  {r}")
            print(f"  → /career-ops apply <slug>")
            print()

    # UNCONFIRMED KB
    with db.tx(db_path) as conn:
        n = conn.execute(
            "SELECT COUNT(*) as c FROM kb_entries WHERE seen_count = 1"
        ).fetchone()["c"]
        if n:
            print(f"UNCONFIRMED KB: {n} entries → /career-ops kb-review\n")

    # KB size
    with db.tx(db_path) as conn:
        total = conn.execute("SELECT COUNT(*) as c FROM kb_entries").fetchone()["c"]
        events_24h = conn.execute("""
            SELECT COUNT(*) as c FROM learning_events
            WHERE created_at > datetime('now', '-1 day')
        """).fetchone()["c"]
        print(f"KB: {total} entries · {events_24h} learning events in last 24h")


def cmd_kb(args):
    cfg = _cfg()
    db_path = str(_ROOT / cfg["paths"]["kb_db"])
    with db.tx(db_path) as conn:
        if args.action == "list":
            rows = conn.execute("""
                SELECT intent_key, answer_type, answer, confidence, seen_count, source
                FROM kb_entries ORDER BY seen_count DESC
            """).fetchall()
            for r in rows:
                print(f"  {r['intent_key']:30s} = {r['answer']!r:30s} "
                      f"({r['answer_type']}, c={r['confidence']:.2f}, "
                      f"n={r['seen_count']}, {r['source']})")
            print(f"\n{len(rows)} entries")

        elif args.action == "get":
            entry = knowledge.lookup_by_intent(conn, args.key)
            variants = conn.execute(
                "SELECT question_text FROM kb_question_variants WHERE intent_key = ?",
                (args.key,)
            ).fetchall()
            history = conn.execute("""
                SELECT event_type, old_answer, new_answer, created_at
                FROM learning_events WHERE intent_key = ?
                ORDER BY created_at DESC LIMIT 10
            """, (args.key,)).fetchall()
            print(json.dumps({
                "entry": entry,
                "variants": [v["question_text"] for v in variants],
                "history": [dict(h) for h in history],
            }, indent=2, default=str))

        elif args.action == "set":
            knowledge.upsert(
                conn, intent_key=args.key, answer=args.value,
                question_text=f"(manual seed: {args.key})",
                source="manual", confidence=1.0,
            )
            print(f"set {args.key} = {args.value!r}")


# ---------- CLI ----------

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init")
    a = sub.add_parser("serve", help="Run the local API the browser extension talks to")
    a.add_argument("--port", type=int, default=None)
    a.add_argument("--reset-pair", action="store_true", help="Forget the paired browser profile")
    sub.add_parser("retry", help="Re-run fields whose learning failed earlier")
    sub.add_parser("doctor", help="Check that everything the extension needs is installed and set up")
    a = sub.add_parser("install-service", help="Run the server at login through a macOS LaunchAgent")
    a.add_argument("--load", action="store_true", help="Start it now (default: only write the plist)")
    a.add_argument("--remove", action="store_true")

    a = sub.add_parser("kb")
    a.add_argument("action", choices=["list", "get", "set"])
    a.add_argument("key", nargs="?")
    a.add_argument("value", nargs="?")

    # LinkedIn
    a = sub.add_parser("linkedin-url",
                       help="Print LinkedIn search URL for manual browsing")
    a.add_argument("query")
    a.add_argument("--date-posted", default="past-24h",
                   choices=["past-24h", "past-week", "past-month", "any"])
    a.add_argument("--experience", default="any",
                   choices=["entry", "associate", "mid-senior", "director", "any"])
    a.add_argument("--remote", default="any",
                   choices=["onsite", "remote", "hybrid", "any"])
    a.add_argument("--location", default=None)
    a.add_argument("--all", action="store_true",
                   help="Include non-Easy-Apply jobs (default: EA only)")

    a = sub.add_parser("linkedin-add",
                       help="Add one or more LinkedIn URLs to the inbox manually")
    a.add_argument("urls", nargs="+", help="One or more job URLs")
    a.add_argument("--company", default=None)
    a.add_argument("--role", default=None)
    a.add_argument("--jd-file", dest="jd_file", default=None)

    # KB review
    sub.add_parser("kb-review")
    a = sub.add_parser("kb-approve"); a.add_argument("key")
    a = sub.add_parser("kb-delete"); a.add_argument("key")

    # Briefing
    sub.add_parser("briefing")

    args = p.parse_args()

    handlers = {
        "init": cmd_init, "serve": cmd_serve, "doctor": cmd_doctor, "install-service": cmd_service, "retry": cmd_retry, "kb": cmd_kb,
        "linkedin-url": cmd_linkedin_url,
        "linkedin-add": cmd_linkedin_add,
        "kb-review": cmd_kb_review,
        "kb-approve": cmd_kb_approve,
        "kb-delete": cmd_kb_delete,
        "briefing": cmd_briefing,
    }
    handlers[args.cmd](args)


if __name__ == "__main__":
    main()
