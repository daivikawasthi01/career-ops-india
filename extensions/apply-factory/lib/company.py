"""
The Company tab: who a company is and how to reach the right people, from public sources only.

Steps, each cached together for company.cache_days:
 1. The company's website domain: from the scanner's own discovery files, else the job link when it is not a job board.
 2. A few public pages of that site (robots.txt permitting) read for email addresses and phone numbers, each with the page it came from.
 3. A web search for size, then for the people who matter at that size. The search returns the pages it used; a person is kept only
    when their source page is one of them, so a name the model made up has no source and is dropped.
 4. Optionally, people you already know there (data/Connections.csv through career-ops' linkedin-join.mjs).
Email guessing and the mail-server check live in mailcheck.py. Nothing here sends anything.
"""
from __future__ import annotations

import csv
import json
import re
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timedelta, timezone
from typing import Callable

from . import config, llm, mailcheck, nodecli

UA = "apply-factory/0.6"
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_OBFUSCATED = re.compile(r"([A-Za-z0-9._%+-]+)\s*[\[\(]\s*at\s*[\]\)]\s*([A-Za-z0-9-]+(?:\s*[\[\(]\s*dot\s*[\]\)]\s*[A-Za-z0-9-]+)+)", re.I)
_TEL = re.compile(r'href="tel:([+0-9()\-.\s%]{7,22})"', re.I)
_PHONE_TEXT = re.compile(r"(?:call|phone|tel|contact|reach us)[^<>\n]{0,30}?(\+?\d[\d\s().-]{8,16}\d)", re.I)
_PAGE_MAX = 400_000


def _cfg() -> dict:
    return config.load().get("company") or {}


def _fetch_text(url: str, timeout: float = 8) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,text/plain"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            ctype = r.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return r.status, ""
            return r.status, r.read(_PAGE_MAX).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (OSError, ValueError):
        return 0, ""


# The outside-world seams. Tests replace these names.
fetch_text: Callable[..., tuple[int, str]] = _fetch_text
search: Callable[..., dict] = llm.web_search  # looked up at call time through _search() so llm's own seams still apply


def _search(prompt: str, **kw) -> dict:
    return llm.web_search(prompt, **kw) if search is llm.web_search else search(prompt, **kw)


def norm(name: str) -> str:
    s = re.sub(r"\b(pvt|private|ltd|limited|inc|llc|llp|corp|corporation|technologies|technology|labs|india|the)\b", " ", name.lower())
    return re.sub(r"[^a-z0-9]+", "", s)


def host_of(url: str) -> str:
    try:
        h = urllib.parse.urlparse(url if "//" in url else "//" + url).hostname or ""
    except ValueError:
        return ""
    return h[4:] if h.startswith("www.") else h.lower()


def _tsv(path, key_col: str, val_col: str) -> dict[str, str]:
    try:
        with open(path, newline="", encoding="utf-8") as f:
            return {norm(r.get(key_col, "")): r.get(val_col, "") for r in csv.DictReader(f, delimiter="\t") if r.get(key_col)}
    except (OSError, csv.Error):
        return {}


def domain_for(company: str, job_url: str = "") -> tuple[str, str]:
    """(domain, where it came from). Empty when nothing reliable is known; the search can still find one."""
    key = norm(company)
    dom = _tsv(config.path("careers_discovery"), "company", "domain").get(key, "").strip().lower()
    if dom:
        return host_of(dom), "scanner discovery"
    url = _tsv(config.path("careers_directory"), "company", "careers_url").get(key, "")
    h = host_of(url)
    if h and not _is_board(h):
        return _registrable(h), "careers directory"
    h = host_of(job_url)
    if h and not _is_board(h):
        return _registrable(h), "job link"
    return "", ""


def _is_board(host: str) -> bool:
    return any(host == b or host.endswith("." + b) for b in _cfg().get("not_company_hosts", []))


def _registrable(host: str) -> str:
    """careers.acme.com -> acme.com (and acme.co.in -> acme.co.in). A short table of two-part suffixes is enough here."""
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in {"co.in", "co.uk", "com.au", "co.jp", "com.sg", "co.nz", "com.br", "org.in", "net.in"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) > 2 else host


def _allowed(domain: str) -> Callable[[str], bool]:
    rp = urllib.robotparser.RobotFileParser()
    code, body = fetch_text(f"https://{domain}/robots.txt")
    if code == 200 and body:
        rp.parse(body.splitlines())
        return lambda path: rp.can_fetch(UA, f"https://{domain}{path}")
    return lambda path: True


def _deobfuscate(m: re.Match) -> str:
    host = re.sub(r"\s*[\[(]\s*dot\s*[\])]\s*", ".", m.group(2), flags=re.I)
    return f"{m.group(1)}@{host}"


def extract_contacts(html: str, domain: str, page: str) -> tuple[list[dict], list[dict]]:
    """Emails on the company's own domain and phone numbers found in a page, each tagged with the page it came from."""
    found: dict[str, str] = {}
    for a in _EMAIL.findall(html) + [_deobfuscate(m) for m in _OBFUSCATED.finditer(html)]:
        a = a.strip(".").lower()
        if a.endswith((".png", ".jpg", ".svg", ".webp", ".gif", ".js", ".css")):
            continue
        if a.split("@")[-1] == domain or a.split("@")[-1].endswith("." + domain):
            found.setdefault(a, page)
    phones: dict[str, str] = {}
    for raw in _TEL.findall(html) + _PHONE_TEXT.findall(html):
        num = urllib.parse.unquote(raw).strip()
        digits = re.sub(r"\D", "", num)
        if 8 <= len(digits) <= 15 and len(set(digits)) > 3:
            phones.setdefault(re.sub(r"\s+", " ", num), page)
    return ([{"address": a, "source": s} for a, s in found.items()], [{"number": n, "source": s} for n, s in phones.items()])


def crawl(domain: str) -> dict:
    """Public emails and phones from a few pages of the company's own site. Honours robots.txt; one request per page."""
    ok = _allowed(domain)
    emails: dict[str, dict] = {}
    phones: dict[str, dict] = {}
    read = []
    for path in _cfg().get("pages", ["/"]):
        if not ok(path):
            continue
        url = f"https://{domain}{path}"
        code, html = fetch_text(url)
        if code != 200 and path == "/":
            code, html = fetch_text(f"https://www.{domain}/")
            url = f"https://www.{domain}/"
        if code != 200 or not html:
            continue
        read.append(url)
        es, ps = extract_contacts(html, domain, url)
        for e in es:
            emails.setdefault(e["address"], e)
        for p in ps:
            phones.setdefault(re.sub(r"\D", "", p["number"]), p)
    return {"emails": list(emails.values()), "phones": list(phones.values()), "pages": read}


def band_for(employees: int | None) -> str:
    if not employees:
        return "unknown"
    for b in _cfg().get("bands", []):
        if employees <= b["max"]:
            return b["name"]
    return "large"


def _json_in(text: str) -> dict:
    """The first JSON object in a model answer (it may be wrapped in a code fence or prose)."""
    dec = json.JSONDecoder()
    for m in re.finditer(r"\{", text):
        try:
            obj, _ = dec.raw_decode(text[m.start():])
            if isinstance(obj, dict):
                return obj
        except ValueError:
            continue
    return {}


def _trusted(url: str, sources: list[dict]) -> bool:
    """A cited page counts only when the search itself returned that page or another page on the same site."""
    h = host_of(url)
    return bool(h) and any(host_of(s.get("uri", "")) == h for s in sources)


def _int(v) -> int | None:
    try:
        n = int(float(str(v).replace(",", "")))
        return n if n > 0 else None
    except (TypeError, ValueError):
        return None


def research_overview(company: str, domain: str) -> dict:
    where = f" (website {domain})" if domain else ""
    ans = _search(
        f'Company: "{company}"{where}. Find how many employees it has (the most recent figure and its date), the headquarters city, and what it does '
        'in one sentence. Use only what you find on pages; if you cannot find a figure use null. Reply with JSON only: '
        '{"employees": number|null, "employees_note": "text with the date", "hq": "city, country"|null, "summary": "one sentence"|null, '
        '"website": "domain you found"|null, "source": "page url used for the headcount"|null}')
    data = _json_in(ans["text"])
    src = data.get("source") if _trusted(str(data.get("source") or ""), ans["sources"]) else None
    n = _int(data.get("employees"))
    return {"employees": n, "note": data.get("employees_note") or None, "band": band_for(n), "hq": data.get("hq"), "summary": data.get("summary"),
            "website": host_of(str(data.get("website") or "")) or None, "source": src, "sources": ans["sources"]}


_STOP = {"inc", "ltd", "limited", "pvt", "private", "llc", "llp", "corp", "corporation", "the", "and", "group", "technologies", "technology", "labs", "india", "co", "company"}


def domain_guesses(company: str, website: str) -> list[str]:
    """Domains a company might mail from: its initials (Goldman Sachs -> gs.com), first word, whole name, on the website's own ending and .com."""
    words = [w.lower() for w in re.findall(r"[A-Za-z]+", company) if w.lower() not in _STOP]
    if not words:
        return []
    stems = ["".join(w[0] for w in words)] if len(words) > 1 else []
    stems += [words[0], "".join(words)]
    ends = ["com"]
    if website and "." in website:
        tail = website.split(".", 1)[1]
        if tail not in ends:
            ends.insert(0, tail)
    return [f"{st}.{e}" for st in dict.fromkeys(stems) if len(st) >= 2 for e in ends]


def email_domains(company: str, website: str) -> tuple[list[dict], list[str], list[dict]]:
    """Where this company's work email lives, best first, each with a mail server: what the web says its addresses look like, then the
    website, then guesses. Returns (domains, shapes the evidence points to, the example addresses behind them). The examples are real
    employee addresses a page shows, so even a cut shape (8-character user names) is learned from them. A guess is only kept with a mail server."""
    found: list[tuple[str, str]] = []
    shapes: list[str] = []
    examples: list[dict] = []
    try:
        ans = _search(f'What email address format and domain do employees of "{company}" use for work email (for example first.last@domain)? '
                      'Give the domains you find, each with the page you found it on, and up to 5 real employee examples (the person\'s full name and their '
                      'work address exactly as a page shows it). Never guess or construct an address. Reply with JSON only: '
                      '{"domains": [{"domain": "example.com", "pattern": "first.last"|null, "source": "page url"}], '
                      '"examples": [{"name": "Full Name", "email": "address", "source": "page url"}]}')
        for d in (_json_in(ans["text"]).get("domains") or []):
            dom = host_of(str(d.get("domain") or "")).removeprefix("@")
            if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", dom) and not _is_board(dom):
                trusted = _trusted(str(d.get("source") or ""), ans["sources"])
                found.append((dom, "web search" if trusted else "web search, unconfirmed"))
                if trusted and (sh := mailcheck.shape_from_pattern(str(d.get("pattern") or ""))):
                    shapes.append(sh)
        for ex in (_json_in(ans["text"]).get("examples") or []):
            addr, nm = str(ex.get("email") or "").strip().lower(), str(ex.get("name") or "").strip()
            dom = addr.rpartition("@")[2]
            if _EMAIL.fullmatch(addr) and nm and _trusted(str(ex.get("source") or ""), ans["sources"]) and not _is_board(dom):
                examples.append({"name": nm, "address": addr, "source": str(ex["source"])})
                found.append((dom, "web search"))
        shapes = [*mailcheck.learn_shapes([(e["name"], e["address"]) for e in examples]), *shapes]
    except llm.LLMUnavailable:
        pass  # the website and the guesses still work
    order = found + ([(website, "website")] if website else []) + [(g, "guess") for g in domain_guesses(company, website)]
    out: list[dict] = []
    for dom, how in order:
        if dom in {o["domain"] for o in out}:
            continue
        hosts = mailcheck.mail_hosts(dom)
        if hosts:
            out.append({"domain": dom, "from": how, "provider": mailcheck.provider(hosts)})
        if len(out) >= int(_cfg().get("email_domains", 3)):
            break
    return out, list(dict.fromkeys(shapes)), examples


def _people_plan(roles: list[str], job_title: str, location: str) -> list[str]:
    """The searches, in order: the team that hires for this job, HR and recruiters in the job's city (else each default city), then
    each role that matters at this company's size."""
    cfg = _cfg()
    where = f" in {location}" if location else ""
    plan = []
    if job_title:
        plan.append(f'the hiring manager, team lead or recruiter for a "{job_title}" role{where}')
    for loc in ([location] if location else cfg.get("default_locations", [])):
        plan.append(f"HR, talent acquisition or technical recruiters based in {loc}")
    return plan + roles


def _people_prompt(company: str, domain: str, role: str) -> str:
    where = f" (website {domain})" if domain else ""
    return (f'Company: "{company}"{where}. Find the CURRENT people who are: {role}. Only people you actually found on a page, each with the page url. '
            'Never guess a name; return fewer people rather than invent one. Reply with JSON only: '
            '{"people": [{"name": "...", "title": "...", "kind": "founder|engineering|talent|hr|manager|other", "source": "page url", '
            '"linkedin": "profile url if the page shows it"|null}]}')


def _read_people(answer: dict) -> tuple[list[dict], int]:
    kept, dropped = [], 0
    for p in (_json_in(answer["text"]).get("people") or []):
        name = re.sub(r"\s+", " ", str(p.get("name") or "")).strip()
        if len(name.split()) < 2 or re.search(r"\d|@", name) or not _trusted(str(p.get("source") or ""), answer["sources"]):
            dropped += 1
            continue
        li = str(p.get("linkedin") or "")
        kept.append({"name": name, "title": str(p.get("title") or "")[:120], "kind": str(p.get("kind") or "other"), "source": str(p["source"]),
                     "linkedin": li if "linkedin.com/in/" in li else None, "partial": len(name.split()[-1].rstrip(".")) < 2})
    return kept, dropped


def research_people(company: str, domain: str, band: str, job_title: str, location: str = "") -> tuple[list[dict], list[dict], int]:
    """One search per kind of person (the hiring team for this job, then each role that matters at this size), merged and de-duplicated.
    Stops as soon as company.people_target people have a source, so a rich company costs fewer searches."""
    cfg = _cfg()
    roles = list((cfg.get("roles") or {}).get(band) or (cfg.get("roles") or {}).get("mid", []))
    people: dict[str, dict] = {}
    sources: list[dict] = []
    dropped = 0
    for role in _people_plan(roles, job_title, location)[: int(cfg.get("people_queries", 6))]:
        try:
            ans = _search(_people_prompt(company, domain, role))
        except llm.LLMUnavailable:
            if people:
                break  # keep what the earlier searches found
            raise
        sources += ans["sources"]
        kept, d = _read_people(ans)
        dropped += d
        for p in kept:
            people.setdefault(p["name"].lower(), p)
        if len(people) >= int(cfg.get("people_target", 6)):
            break
    return list(people.values())[:12], sources, dropped


def network(company: str) -> list[dict]:
    """People you know there, from your LinkedIn export, when you have exported one. Nothing is sent anywhere."""
    if not config.path("connections").exists():
        return []
    code, out, _ = nodecli.run(["linkedin-join.mjs", "--company", company], timeout=30)
    if code != 0:
        return []
    try:
        targets = json.loads(out).get("targets") or []
    except ValueError:
        return []
    return [{"name": c.get("name", ""), "title": c.get("title", ""), "url": c.get("url", "")}
            for t in targets for c in (t.get("connections") or [])][:10]


def research(company: str, job_url: str = "", job_title: str = "", location: str = "") -> dict:
    """The whole lookup. Raises llm.LLMUnavailable when no search backend can answer; the site crawl and network parts still run first."""
    domain, how = domain_for(company, job_url)
    out: dict = {"company": company, "domain": domain, "domain_from": how, "job_title": job_title, "location": location, "warnings": [],
                 "generated_at": datetime.now().isoformat(timespec="seconds")}
    if domain:
        out["contacts"] = crawl(domain)
    else:
        out["contacts"] = {"emails": [], "phones": [], "pages": []}
    out["network"] = network(company)
    ov = research_overview(company, domain)
    if not domain and ov.get("website") and not _is_board(ov["website"]):
        domain = _registrable(ov["website"])
        out.update(domain=domain, domain_from="web search")
        out["contacts"] = crawl(domain)
    out["email_domains"], out["email_shapes"], out["email_examples"] = email_domains(company, domain)
    out["size"] = {k: ov[k] for k in ("employees", "note", "band", "source")}
    out["hq"], out["summary"] = ov["hq"], ov["summary"]
    people, psrc, dropped = research_people(company, domain, ov["band"], job_title, location)
    out["people"] = people
    own = mailcheck.learn_shapes([(p["name"], e["address"]) for p in people for e in out["contacts"]["emails"]])
    out["email_shapes"] = list(dict.fromkeys([*out["email_shapes"], *own]))
    out["roles_wanted"] = (_cfg().get("roles") or {}).get(ov["band"], [])
    seen = {s["uri"]: s for s in ov["sources"] + psrc if s.get("uri")}
    out["sources"] = list(seen.values())[:20]
    if dropped:
        out["warnings"].append(f"{dropped} name(s) the search gave were left out because no page backs them.")
    if ov["band"] == "unknown":
        out["warnings"].append("No headcount was found, so the people shown are the mid-size set.")
    if not out["email_domains"]:
        out["warnings"].append("No mail server was found for this company's domains, so addresses cannot be checked.")
    elif out["email_domains"][0]["domain"] != domain and domain:
        out["warnings"].append(f"Work email seems to use {out['email_domains'][0]['domain']}, not the website domain {domain}.")
    if not people:
        out["warnings"].append("No named people were found with a source page. Try the LinkedIn company page for the hiring team.")
    return out


def cache_get(conn, key: str, days: int) -> dict | None:
    row = conn.execute("SELECT result_json, created_at FROM company_cache WHERE cache_key=?", (key,)).fetchone()
    if not row:
        return None
    try:
        made = datetime.fromisoformat(row[1].replace(" ", "T"))
    except ValueError:
        return None
    if datetime.now(timezone.utc).replace(tzinfo=None) - made > timedelta(days=days):
        return None
    return {**json.loads(row[0]), "cached_at": row[1]}


def cache_put(conn, key: str, result: dict) -> None:
    conn.execute("INSERT OR REPLACE INTO company_cache(cache_key, result_json, created_at) VALUES (?,?,CURRENT_TIMESTAMP)", (key, json.dumps(result)))


def _key(company: str, location: str) -> str:
    return "company:" + norm(company) + (":" + norm(location) if location else "")


def cached(conn, company: str, location: str = "") -> dict | None:
    return cache_get(conn, _key(company, location), int(_cfg().get("cache_days", 14)))


def store(conn, company: str, result: dict, location: str = "") -> None:
    cache_put(conn, _key(company, location), result)
