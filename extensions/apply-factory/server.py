"""
Local API for the browser extension. Binds to 127.0.0.1 only.

  GET  /rules      rules/rules.json, so the extension and the server never disagree
  GET  /status     model availability and knowledge-base counts
  POST /pair       first call from the extension returns the shared token and pins the extension id
  POST /suggest    {url, title, fields[]}            -> known answers, no model call
  POST /draft      {field, ctx}                      -> one model call for one field
  POST /jobs        {q, sources[], days, confirmed_only, ...} -> one page of the scanner's jobs.db, read only
  POST /jobs/years  {start}                          -> reads the years each posting's text asks for, in the background; returns progress
  POST /blacklist/list | /blacklist/add {company, reason} | /blacklist/update {line, company_was, company, reason} | /blacklist/remove {line, company}
                                                     -> edits career-ops' data/blacklist.md; add also deletes that company's jobs from jobs.db, remove forgets their tombstones
  POST /jobs/mark   {id, mark}                       -> applied / dismissed / saved, kept in kb.sqlite
  POST /company/start {company, url, title, location, website, refresh} -> {cached, result} or {job}: size, people, public emails and phones (poll /cv/job)
  POST /mail/find    {name, domain, known[]}         -> {job}: likely addresses for a person, checked against the mail server, with risk bands
  POST /mail/generic {domain}                        -> {job}: careers@, jobs@, hr@ ... checked the same way
  POST /outreach/draft {person, company, title, jd_text} -> a short cold email (subject, body) from your CV and the job
  POST /outreach/cover {company, title, jd_text, person_name} -> {tex, text}: a cover letter for this job as LaTeX (compile it with /cv/compile)
  POST /outreach/gmail {to, subject, body, attach_cv, attach_cover, cover_tex, ...} -> {job}: a Gmail draft with the CV and a cover letter attached; never sends
  POST /outreach/compose {to, subject, body, person, company} -> Gmail's compose window address (no attachments); notes the contact
  POST /gmail/status | /gmail/connect | /gmail/disconnect; GET /gmail/callback is where Google's sign-in returns
  POST /draft_batch {fields[], ctx}                  -> several long answers in one hosted call; "single" lists ids to ask one by one
  POST /resume/upload {kind, base64} -> replace a CV slot (the previous file is kept)
  POST /resume/upload {kind, base64}                -> replace a CV slot (the old file is kept)
  POST /cv/*       CV studio: slots, tex, compile, publish; import, tailor and fix return a job id that /cv/job polls
  POST /score      quick job score on career-ops' five dimensions
  POST /preflight  blacklist, earlier application, liveness, aggregator and report checks for a posting
  POST /applied    mark the application as Applied in the career-ops tracker; /queue sends it to the pipeline
  POST /cover      draft a cover letter; /cover/pdf compiles it
  POST /pick       {answer, options[]}               -> which dropdown option means the answer
  POST /capture    {url, title, company, fields[]}   -> learn the final answers (queued, returns at once)
  POST /retry      re-run fields that failed earlier
  POST /resume     {title, jd_text} -> the CV pdf for that role (default or DevOps), base64 in JSON

Every call except /pair needs the X-Token header. Host must be a loopback name (DNS rebinding guard).
"""
from __future__ import annotations

import base64
import html
import json
import queue
import re
import secrets
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from learner import learn as learner
from lib import (checks, company as companies, config, cover, cv_import, cv_store, db, gmail, jobs, knockout, llm, mailcheck, options, outreach, resume, rules,
                 score as scorer, suggest, tailor, tex, tracker, years)
from lib import blacklist, jobs_prune

MAX_BODY = 16 * 1024 * 1024  # a CV pdf arrives as base64
STATE_FILE = config.ROOT / "data" / "server.json"


class State:
    """Token, pinned extension id and the learning queue. One per server."""

    def __init__(self, db_path: str, state_file: Path | None = None):
        self.db_path = db_path
        self.state_file = state_file or STATE_FILE
        self.lock = threading.Lock()
        self.jobs: queue.Queue = queue.Queue()
        self.last_capture: dict = {}
        self.reports: dict[str, str] = {}  # url_key -> report path, filled by /preflight
        self.long_jobs: dict[str, dict] = {}  # id -> {status, result|error}; slow model calls run here and are polled
        self._load()
        db.init(db_path, str(config.ROOT / "schema.sql"))

    def spawn(self, fn) -> str:
        """Run a slow call in a thread and return its id. A browser extension's service worker cannot hold one request open for minutes."""
        job_id = secrets.token_hex(6)
        self.long_jobs[job_id] = {"status": "running"}
        if len(self.long_jobs) > 50:  # forget the oldest finished ones
            for k in [k for k, v in self.long_jobs.items() if v["status"] != "running"][:25]:
                self.long_jobs.pop(k, None)

        def run():
            try:
                self.long_jobs[job_id] = {"status": "done", "result": fn()}
            except (ValueError, KeyError, FileNotFoundError, tex.ToolMissing, llm.LLMUnavailable) as e:
                self.long_jobs[job_id] = {"status": "error", "error": str(e)[:300]}
            except Exception as e:
                self.long_jobs[job_id] = {"status": "error", "error": f"{type(e).__name__}: {e}"[:300]}
        threading.Thread(target=run, daemon=True).start()
        return job_id

    def _load(self) -> None:
        try:
            self.data = json.loads(self.state_file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self.data = {}

    def pair(self, extension_id: str) -> str | None:
        with self.lock:
            if not self.data.get("token"):
                self.data = {"token": secrets.token_urlsafe(32), "extension_id": extension_id}
                self.state_file.parent.mkdir(parents=True, exist_ok=True)
                self.state_file.write_text(json.dumps(self.data))
                self.state_file.chmod(0o600)
            return self.data["token"] if self.data.get("extension_id") == extension_id else None

    def token_ok(self, token: str | None) -> bool:
        return bool(token) and bool(self.data.get("token")) and secrets.compare_digest(token, self.data["token"])

    def worker(self) -> None:
        while True:
            job = self.jobs.get()
            try:
                events = learner.learn_fields(self.db_path, job["fields"], url_key=job["url_key"], company=job.get("company", ""))
                self.last_capture = {"at": job["at"], "url_key": job["url_key"],
                                     **{k: len(v) for k, v in events.items()}}
            except Exception as e:  # keep the worker alive; the failure is shown through /status
                self.last_capture = {"at": job["at"], "error": str(e)[:200]}
            finally:
                self.jobs.task_done()


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _remove_too_senior(db_path: str) -> int:
    """After the years check: take the jobs that clearly ask for more years than you have out of jobs.db (jobs.auto_remove)."""
    if not (config.load().get("jobs") or {}).get("auto_remove", True):
        return 0
    with db.tx(db_path) as conn:
        return jobs_prune.remove(conn)["removed"]


def _pages(pdf: bytes | None, dpi: int = 90) -> list[str]:
    return [_b64(p) for p in tex.pdf_pages_png(pdf, dpi=dpi)] if pdf else []


def _counts(db_path: str) -> dict:
    with db.tx(db_path) as conn:
        one = lambda q: conn.execute(q).fetchone()[0]
        return {"answers": one("SELECT COUNT(*) FROM kb_entries"), "wordings": one("SELECT COUNT(*) FROM kb_question_variants"),
                "samples": one("SELECT COUNT(*) FROM writing_samples"), "pending": one("SELECT COUNT(*) FROM pending_fields")}


def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = "apply-factory"

        def log_message(self, fmt, *args):  # quiet: form labels must not end up in a log
            pass

        def _origin(self) -> str:
            return self.headers.get("Origin", "")

        def _send(self, code: int, body: dict | bytes, ctype: str = "application/json"):
            raw = body if isinstance(body, bytes) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(raw)))
            if self._origin().startswith("chrome-extension://"):
                self.send_header("Access-Control-Allow-Origin", self._origin())
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(raw)

        def _host_ok(self) -> bool:
            host = self.headers.get("Host", "").rsplit(":", 1)[0].strip("[]")
            return host in ("127.0.0.1", "localhost")

        def do_OPTIONS(self):
            self.send_response(204)
            if self._origin().startswith("chrome-extension://"):
                self.send_header("Access-Control-Allow-Origin", self._origin())
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Token")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("body too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def _route(self, method: str):
            if not self._host_ok():
                return self._send(403, {"error": "bad host"})
            path = self.path.split("?")[0]
            if path == "/gmail/callback" and method == "GET":
                return self._gmail_callback()
            if path == "/pair" and method == "POST":
                origin = self._origin()
                if not origin.startswith("chrome-extension://"):
                    return self._send(403, {"error": "pairing is for the extension only"})
                token = state.pair(origin.removeprefix("chrome-extension://").rstrip("/"))
                return self._send(200, {"token": token}) if token else self._send(403, {"error": "another extension is already paired"})
            if not state.token_ok(self.headers.get("X-Token")):
                return self._send(401, {"error": "pair first"})
            try:
                return self._dispatch(method, path)
            except tex.ToolMissing as e:
                return self._send(501, {"error": str(e)})
            except llm.LLMUnavailable as e:
                return self._send(503, {"error": "model unavailable", "detail": str(e)[:200]})
            except (gmail.GmailError, blacklist.BlacklistError) as e:
                return self._send(409, {"error": str(e)})
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                return self._send(400, {"error": f"bad request: {e}"[:200]})

        def _gmail_callback(self):
            """Google sends the browser back here after sign-in. The one-use state value proves this app started it."""
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try:
                if q.get("error"):
                    raise gmail.GmailError(f"Google said: {q['error'][0]}")
                gmail.finish(q.get("state", [""])[0], q.get("code", [""])[0])
                msg = "Gmail is connected. You can close this tab and go back to the extension."
            except gmail.GmailError as e:
                msg = str(e)
            page = f"<!doctype html><meta charset=utf-8><title>Gmail</title><body style='font:16px system-ui;margin:3rem'><p>{html.escape(msg)}</p>"
            return self._send(200, page.encode(), "text/html; charset=utf-8")

        def _dispatch(self, method: str, path: str):
            if method == "GET" and path == "/rules":
                return self._send(200, rules.load())
            if method == "GET" and path == "/status":
                return self._send(200, {"llm": llm.status(), "counts": _counts(state.db_path), "last_capture": state.last_capture,
                                        "queued": state.jobs.qsize(), "resumes": resume.status()})
            if method != "POST":
                return self._send(404, {"error": "not found"})
            body = self._body()
            if path == "/suggest":
                host = (body.get("url") or "").split("/")[2] if "//" in (body.get("url") or "") else ""
                if rules.site_mode(host) != "assist":
                    return self._send(200, {"mode": rules.site_mode(host), "results": []})
                with db.tx(state.db_path) as conn:
                    return self._send(200, {"mode": "assist", "results": suggest.suggest(conn, body["fields"]),
                                            "warnings": knockout.warnings(body["fields"])})
            if path in ("/draft", "/draft_batch"):
                ctx = dict(body.get("ctx") or {})
                key = learner._url_key(body.get("url", ""))
                if key not in state.reports and body.get("url"):  # no preflight yet: a report for this posting is a cheap lookup
                    hit = checks.report_for(str(ctx.get("company", "")), str(body["url"]))
                    if hit.get("status") == "match":
                        state.reports[key] = hit["path"]
                ctx["report_path"] = state.reports.get(key, "")
                ctx["fresh"] = bool(body.get("fresh"))  # Write again: skip the cached suggestion
                with db.tx(state.db_path) as conn:
                    if path == "/draft_batch":
                        return self._send(200, suggest.draft_batch(conn, body["fields"], ctx))
                    return self._send(200, suggest.draft(conn, body["field"], ctx))
            if path == "/jobs":
                with db.tx(state.db_path) as conn:
                    return self._send(200, jobs.search(conn, q=str(body.get("q", "")), sources=list(body.get("sources") or []), days=int(body.get("days") or 0),
                                                       confirmed_only=bool(body.get("confirmed_only")), hide_flagged=body.get("hide_flagged", True) is not False,
                                                       hide_marked=body.get("hide_marked", True) is not False, sort=str(body.get("sort", "new")), fit=body.get("fit", True) is not False,
                                                       limit=int(body.get("limit") or 40), offset=int(body.get("offset") or 0)))
            if path == "/jobs/years":   # start reading the postings' text in the background (or just report progress)
                started = False
                if body.get("start", True):
                    with db.tx(state.db_path) as conn:
                        todo = jobs.years_todo(conn)
                    started = years.start(state.db_path, todo, on_done=lambda: _remove_too_senior(state.db_path))
                return self._send(200, {"started": started, **years.progress()})
            if path == "/jobs/mark":
                with db.tx(state.db_path) as conn:
                    jobs.set_mark(conn, str(body["id"]), str(body.get("mark", "")))
                return self._send(200, {"ok": True})
            if path == "/blacklist/list":
                return self._send(200, {"entries": blacklist.entries()})
            if path == "/blacklist/add":
                res = blacklist.add(str(body.get("company", "")), str(body.get("reason", "")), str(body.get("scope", "company")))
                gone = {"removed": 0}
                if res["added"]:   # the click is the user's decision: the company's jobs leave jobs.db now (not marked ones; a backup is saved first)
                    with db.tx(state.db_path) as conn:
                        ids = [c["id"] for c in jobs_prune.candidates(conn) if c["why"].startswith("blacklist:")]
                        gone = jobs_prune.remove(conn, ids) if ids else gone
                return self._send(200, {**res, "removed": gone["removed"]})
            if path == "/blacklist/update":
                return self._send(200, {"entry": blacklist.update(int(body["line"]), str(body["company_was"]), str(body["company"]), str(body.get("reason", "")), body.get("scope"))})
            if path == "/blacklist/remove":
                row = blacklist.remove(int(body["line"]), str(body["company"]))
                back = jobs_prune.restore(row["company"]) if row["scope"] == "company" else {"restored": 0}
                return self._send(200, {"entry": row, **back})
            if path == "/company/start":
                name = str(body["company"]).strip()
                loc = str(body.get("location", "")).strip()
                site = str(body.get("website", "")).strip()
                if not name:
                    return self._send(400, {"error": "company is required"})
                if not body.get("refresh"):
                    with db.tx(state.db_path) as conn:
                        hit = companies.cached(conn, name, loc, site)
                    if hit:
                        return self._send(200, {"cached": True, "result": hit})
                    if body.get("cache_only"):  # the tab opening on a company asks only whether an answer is already saved
                        return self._send(200, {"cached": False})

                def research():
                    res = companies.research(name, str(body.get("url", "")), str(body.get("title", "")), loc, site)
                    with db.tx(state.db_path) as conn:
                        companies.store(conn, name, res, loc, site)
                    return res
                return self._send(200, {"job": state.spawn(research)})
            if path in ("/mail/find", "/mail/generic"):
                domains = [str(d).strip().lower() for d in (body.get("domains") or [body.get("domain", "")]) if str(d).strip()][:3]
                if not domains or not all(re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", d) for d in domains):
                    return self._send(400, {"error": "a domain like acme.com is required"})
                if path == "/mail/find" and len(str(body.get("name", "")).split()) < 2:
                    return self._send(400, {"error": "a first and last name are required"})
                key = "mail:" + ",".join(domains) + ":" + (companies.norm(str(body.get("name", ""))) if path == "/mail/find" else "generic")

                def check():
                    with db.tx(state.db_path) as conn:
                        hit = companies.cache_get(conn, key, int(mailcheck.cfg()["cache_days"]))
                    if hit and not body.get("refresh"):
                        return hit
                    if path == "/mail/find":
                        with db.tx(state.db_path) as conn:
                            seen = companies.cache_get(conn, f"shape:{domains[0]}", 3650)
                        prefer = list(dict.fromkeys([*(body.get("prefer") or []), *([seen["shape"]] if seen else [])]))
                        res = mailcheck.find_multi(str(body["name"]), domains, list(body.get("known") or []), prefer)
                    else:
                        res = mailcheck.generic(domains[0])
                    with db.tx(state.db_path) as conn:
                        companies.cache_put(conn, key, res)
                        good = [r for r in res["rows"] if r["verdict"] == "accepted" and r.get("shape") != "generic"]
                        if good and not res.get("catch_all"):  # the next person at this company starts from the shape that worked
                            companies.cache_put(conn, f"shape:{good[0]['address'].split('@')[1]}", {"shape": good[0]["shape"]})
                    return res
                return self._send(200, {"job": state.spawn(check)})
            if path == "/gmail/status":
                return self._send(200, gmail.status())
            if path == "/gmail/connect":
                return self._send(200, {"url": gmail.start()})
            if path == "/gmail/disconnect":
                gmail.disconnect()
                return self._send(200, gmail.status())
            if path == "/outreach/draft":
                report = state.reports.get(learner._url_key(str(body.get("url", ""))), "")
                return self._send(200, outreach.draft(dict(body["person"]), str(body["company"]), str(body.get("title", "")), str(body.get("jd_text", "")), report))
            if path == "/outreach/cover":
                report = state.reports.get(learner._url_key(str(body.get("url", ""))), "")
                return self._send(200, cover.draft(str(body.get("title", "")), str(body["company"]), str(body.get("jd_text", "")), report, str(body.get("person_name", ""))))
            if path == "/outreach/compose":
                note = outreach.log_contact(dict(body.get("person") or {}), str(body.get("company", "")), str(body.get("to", ""))) if body.get("person") else ""
                return self._send(200, {"url": gmail.compose_url(str(body.get("to", "")), str(body["subject"]), str(body["body"])), "note": note})
            if path == "/outreach/gmail":
                def make_draft():
                    report = state.reports.get(learner._url_key(str(body.get("url", ""))), "")
                    files, notes = outreach.attachments(str(body.get("title", "")), str(body.get("jd_text", "")), str(body.get("company", "")),
                                                        cv=bool(body.get("attach_cv", True)), cover_letter=bool(body.get("attach_cover", True)),
                                                        cover_tex=str(body.get("cover_tex", "")), person_name=str((body.get("person") or {}).get("name", "")), report_path=report)
                    made = gmail.create_draft(str(body.get("to", "")), str(body["subject"]), str(body["body"]), files)
                    note = outreach.log_contact(dict(body.get("person") or {}), str(body.get("company", "")), str(body.get("to", ""))) if body.get("person") else ""
                    return {**made, "attached": [n for n in notes], "files": [f[0] for f in files], "note": note}
                return self._send(200, {"job": state.spawn(make_draft)})
            if path == "/resume":
                try:
                    kind, f = resume.pick(str(body.get("title", "")), str(body.get("jd_text", "")))
                except FileNotFoundError as e:
                    return self._send(404, {"error": str(e)})
                return self._send(200, {"name": f.name, "kind": kind, "label": resume.label_for(kind),
                                        "base64": base64.b64encode(f.read_bytes()).decode()})
            if path == "/resume/upload":
                return self._send(200, resume.save(str(body["kind"]), str(body["base64"])))
            if path.startswith("/cv/"):
                return self._send(200, self._cv(path, body))
            if path == "/score":
                with db.tx(state.db_path) as conn:
                    return self._send(200, scorer.score(conn, str(body.get("title", "")), str(body.get("company", "")), str(body["jd_text"])))
            if path == "/preflight":
                out = checks.preflight(str(body.get("company", "")), str(body.get("title", "")), str(body["url"]))
                if out["report"].get("path"):
                    state.reports[learner._url_key(body["url"])] = out["report"]["path"]
                return self._send(200, out)
            if path == "/applied":
                return self._send(200, tracker.mark_applied(str(body["url"]), str(body.get("company", "")), str(body.get("title", "")), str(body.get("resume", ""))))
            if path == "/queue":
                return self._send(200, tracker.queue(str(body["url"]), str(body.get("company", "")), str(body.get("title", ""))))
            if path == "/cover":
                rp = state.reports.get(learner._url_key(body.get("url", "")), "")
                return self._send(200, cover.draft(str(body.get("title", "")), str(body.get("company", "")), str(body.get("jd_text", "")), rp))
            if path == "/cover/pdf":
                return self._send(200, {"base64": _b64(cover.to_pdf(str(body["text"]), str(body.get("company", "")))),
                                        "name": f"Cover-Letter-{cv_store.slug(str(body.get('company', '')) or 'Application')}.pdf"})
            if path == "/pick":
                hit = options.pick(str(body["answer"]), [str(o) for o in body["options"]][:500])
                return self._send(200, {"option": hit[0] if hit else None, "how": hit[2] if hit else None, "queries": options.queries(str(body["answer"]))})
            if path == "/capture":
                fields = [f for f in body["fields"] if not rules.never_read(f)]
                state.jobs.put({"fields": fields, "url_key": learner._url_key(body.get("url", "")),
                                "company": body.get("company", ""), "at": body.get("at", "")})
                return self._send(202, {"accepted": len(fields)})
            if path == "/retry":
                return self._send(200, learner.retry_pending(state.db_path))
            return self._send(404, {"error": "not found"})

        def _cv(self, path: str, body: dict) -> dict:
            """CV studio calls. Each returns plain data; heavy ones (import, tailor) can take a minute with the local model."""
            if path == "/cv/slots":
                return {"slots": cv_store.slots()}
            if path == "/cv/tex":
                return {"tex": cv_store.read(body["kind"]), "meta": cv_store.meta(body["kind"])}
            if path == "/cv/compile":
                res = tex.compile(str(body["tex"]))
                return {"ok": res["ok"], "errors": res["errors"], "pages": _pages(res["pdf"])}
            if path == "/cv/job":
                job = state.long_jobs.get(str(body["id"]))
                if job is None:
                    raise ValueError("unknown job")
                return job
            if path == "/cv/fix":
                def fix():
                    fixed, res, rounds = cv_import.compile_with_fixes(str(body["tex"]))
                    return {"tex": fixed, "ok": res["ok"], "errors": res["errors"], "rounds": rounds, "pages": _pages(res["pdf"])}
                return {"job": state.spawn(fix)}
            if path == "/cv/publish":
                res = cv_store.publish(body["kind"], str(body["tex"]))
                return {"ok": res["ok"], "errors": res["errors"], "published": res["published"], "pages": _pages(res.get("pdf"))}
            if path == "/cv/save":
                cv_store.save(body["kind"], str(body["tex"]), confirmed=False, source="manual")
                return {"ok": True}
            if path == "/cv/import":
                pdf = base64.b64decode(body["base64"], validate=True)

                def do_import():
                    out = cv_import.import_pdf(pdf)
                    if body.get("kind"):
                        cv_store.save(body["kind"], out["tex"], confirmed=False, source="import")
                    res = tex.compile(out["tex"])
                    return {**out, "original_pages": _pages(pdf), "pages": _pages(res["pdf"])}
                return {"job": state.spawn(do_import)}
            if path == "/cv/tailor":
                def do_tailor():
                    out = tailor.tailor(str(body.get("kind", "default")), str(body["jd_text"]), str(body.get("title", "")), str(body.get("company", "")))
                    res = tex.compile(out["tex_after"])
                    return {**out, "ok": res["ok"], "errors": res["errors"], "pages": _pages(res["pdf"])}
                return {"job": state.spawn(do_tailor)}
            if path == "/cv/tailored/get":
                folder = Path(str(body["folder"])).resolve()
                if not folder.is_relative_to((cv_store.root() / "tailored").resolve()) or not (folder / "cv.pdf").exists():
                    raise ValueError("not a tailored CV folder")
                meta = json.loads((folder / "meta.json").read_text())
                return {"base64": _b64((folder / "cv.pdf").read_bytes()), "name": f"{resume.path_for(meta.get('kind', 'default')).stem}-{cv_store.slug(meta.get('company', ''))}.pdf"}
            if path == "/cv/tailor/save":
                out = cv_store.save_tailored(str(body.get("kind", "default")), str(body["tex"]), str(body.get("jd_text", "")),
                                             str(body.get("title", "")), str(body.get("company", "")))
                return {"ok": out["ok"], "errors": out.get("errors", []), "name": out.get("name"), "base64": _b64(out["pdf"]) if out["ok"] else None}
            raise ValueError(f"unknown cv call {path}")

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

    return Handler


def run(host: str | None = None, port: int | None = None, db_path: str | None = None, reset_pair: bool = False,
        state_file: Path | None = None) -> None:
    cfg = config.load()["server"]
    state_file = state_file or STATE_FILE
    if reset_pair:
        state_file.unlink(missing_ok=True)
    host, port = host or cfg["host"], port if port is not None else cfg["port"]
    state = State(db_path or str(config.path("kb_db")), state_file)
    threading.Thread(target=state.worker, daemon=True).start()
    threading.Thread(target=lambda: _safe_retry(state), daemon=True).start()
    httpd = ThreadingHTTPServer((host, port), make_handler(state))
    print(f"apply-factory listening on http://{host}:{httpd.server_address[1]}  (model: {llm.status().get('chat_model') or 'not reachable'})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def _safe_retry(state: State) -> None:
    try:
        learner.retry_pending(state.db_path)
    except Exception:
        pass


if __name__ == "__main__":
    run()
