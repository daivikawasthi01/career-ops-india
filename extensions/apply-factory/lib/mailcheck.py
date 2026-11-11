"""
Guess a person's work email and check, without sending anything, whether the mail server knows the address.

How a check works: look up the domain's mail servers over DNS-over-HTTPS, open one SMTP session, say MAIL FROM:<> and RCPT TO for a random
address that cannot exist (the control) and then for each candidate. The session ends with QUIT; no message body is ever sent.
- The control accepted: the server takes any address (catch-all), so a yes from it means nothing.
- The control refused and a candidate accepted: the mailbox very likely exists.
- A candidate refused as unknown: it does not exist.
Servers that greylist, hide behind a filtering gateway or block port 25 give no answer; those come back as such, never as a guess.

The risk bands are a rule-of-thumb estimate from what the check saw, not a measured probability. Probes are capped and spaced
(mail.max_probes, mail.delay_seconds) because repeated probing from one address can hurt this Mac's mail reputation.
"""
from __future__ import annotations

import json
import random
import re
import smtplib
import socket
import string
import time
import urllib.parse
import urllib.request
from typing import Callable

from . import config

UA = "apply-factory/0.6"
_DEFAULTS = {"max_probes": 14, "delay_seconds": 1.2, "timeout": 12, "helo": "", "cache_days": 7,
             "generic": ["careers", "jobs", "hr", "talent", "recruiting", "recruitment", "hiring", "people", "hello", "contact", "info"]}

# Which mail host names mean which provider. A filtering gateway often accepts every address and drops the bad ones later.
_PROVIDERS = (("google", ("google.com", "googlemail.com")), ("microsoft", ("outlook.com", "protection.outlook.com")),
              ("proofpoint", ("pphosted.com", "ppe-hosted.com")), ("mimecast", ("mimecast.com",)),
              ("barracuda", ("barracudanetworks.com",)), ("zoho", ("zoho.com", "zoho.in")), ("godaddy", ("secureserver.net",)))
_GATEWAYS = {"proofpoint", "mimecast", "barracuda"}
_UNKNOWN = re.compile(r"user unknown|no such user|does not exist|not exist|unknown (user|recipient)|recipient.*(rejected|not found|unknown)|5\.1\.1|invalid (mailbox|recipient)|mailbox (unavailable|not found)", re.I)
_BLOCK = re.compile(r"spam|block|reputation|blacklist|denied|policy|5\.7\.|not allowed|relay", re.I)


def cfg() -> dict:
    return {**_DEFAULTS, **(config.load().get("mail") or {})}


def _doh(name: str, rtype: str, timeout: float = 6) -> dict:
    url = "https://cloudflare-dns.com/dns-query?" + urllib.parse.urlencode({"name": name, "type": rtype})
    req = urllib.request.Request(url, headers={"accept": "application/dns-json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


# The outside-world seams. Tests replace these names.
doh: Callable[..., dict] = _doh
smtp_factory: Callable[..., smtplib.SMTP] = smtplib.SMTP
sleep: Callable[[float], None] = time.sleep


def _answers(name: str, rtype: str) -> list[str]:
    try:
        return [str(a.get("data", "")) for a in (doh(name, rtype).get("Answer") or [])]
    except (OSError, ValueError):
        return []


def mail_hosts(domain: str) -> list[str]:
    """Mail servers for a domain, best first. Empty when the domain takes no mail."""
    rows = []
    for data in _answers(domain, "MX"):
        m = re.match(r"(\d+)\s+(\S+?)\.?$", data.strip())
        if m and m.group(2) != ".":
            rows.append((int(m.group(1)), m.group(2).lower()))
    return [h for _, h in sorted(rows)]


def provider(hosts: list[str]) -> str:
    for name, needles in _PROVIDERS:
        if any(h.endswith(n) or f".{n}" in h for h in hosts for n in needles):
            return name
    return "other"


def policy(domain: str) -> dict:
    """SPF and DMARC as the domain publishes them; they say how strictly the domain treats mail, not whether a mailbox exists."""
    spf = any(t.strip('"').lower().startswith("v=spf1") for t in _answers(domain, "TXT"))
    dmarc = "missing"
    for t in _answers(f"_dmarc.{domain}", "TXT"):
        m = re.search(r"p=(none|quarantine|reject)", t.lower())
        if m:
            dmarc = m.group(1)
    return {"spf": spf, "dmarc": dmarc}


def _ascii(s: str) -> str:
    import unicodedata
    return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower())


# Shapes a company's address can take. f=first name, l=last name, fi / li = their initials.
_SHAPES = {"first.last": "{f}.{l}", "first": "{f}", "last": "{l}", "flast": "{fi}{l}", "firstl": "{f}{li}", "firstlast": "{f}{l}",
           "first_last": "{f}_{l}", "first-last": "{f}-{l}", "last.first": "{l}.{f}", "lastf": "{l}{fi}", "f.last": "{fi}.{l}", "first.l": "{f}.{li}",
           "lfirst": "{li}{f}", "last_first": "{l}_{f}", "last-first": "{l}-{f}", "lastfirst": "{l}{f}", "l.first": "{li}.{f}", "fl": "{fi}{li}"}
# Roughly by how common they are; the company's own shape (learned or found) goes in front of this list.
_ORDER = ["first.last", "first", "flast", "firstl", "last", "firstlast", "first_last", "last.first", "f.last", "lastf", "first.l", "first-last",
          "lfirst", "last_first", "lastfirst", "l.first", "last-first", "fl"]
_NEEDS_LAST = {k for k, v in _SHAPES.items() if "{l}" in v or "{li}" in v}
_TRUNC = (8, 7, 6)   # old mail systems cap the user name: "psharma" from "Priya Sharma", "pbhattac" from "Priya Bhattacharya"


def local_part(name: str, shape: str) -> str | None:
    """A shape is a base ('first.last') or a base cut to N characters ('flast:8'); None when the name cannot make it."""
    base, _, cut = shape.partition(":")
    parts = [_ascii(p) for p in name.replace("-", " ").split() if _ascii(p)]
    if base not in _SHAPES or not parts:
        return None
    f, l = parts[0], parts[-1] if len(parts) > 1 else ""
    if len(l) < 2:
        l = ""  # "Ravi K." gives only an initial: last-name shapes would be a guess of a guess
    if base in _NEEDS_LAST and not l:
        return None
    local = _SHAPES[base].format(f=f, l=l, fi=f[:1], li=l[:1])
    return local[: int(cut)] if cut.isdigit() else local


def shape_of(name: str, address: str) -> str | None:
    """Which shape a known (name, address) pair follows, including a cut one: 'psharma' for Priya Sharma is flast, 'pbhattac' for
    Priya Bhattacharya is flast:8. None when the address is not built from the name."""
    local = address.split("@")[0].lower()
    for base in _ORDER:
        full = local_part(name, base)
        if full == local:
            return base
    for base in _ORDER:
        full = local_part(name, base)
        if full and len(local) in range(5, 13) and len(full) > len(local) and full.startswith(local):
            return f"{base}:{len(local)}"
    return None


def learn_shapes(pairs: list[tuple[str, str]]) -> list[str]:
    """Shapes seen in (name, address) pairs, most common first."""
    seen = [sh for n, a in pairs if (sh := shape_of(n, a))]
    return sorted(set(seen), key=lambda x: (-seen.count(x), x))


_PATTERN_NAMES = {k: k for k in _SHAPES}
_PATTERN_NAMES.update({"first.l": "first.l", "firstinitiallast": "flast"})


def shape_from_pattern(text: str) -> str | None:
    """'firstname.lastname@gs.com', '{first}.{last}', 'first initial + last name' -> one of the shapes, or None when it is not one of ours."""
    t = (text or "").lower().split("@")[0]
    t = re.sub(r"[{}\[\]<>\s]", "", t)
    t = t.replace("firstinitial", "f").replace("finitial", "f").replace("firstname", "first").replace("lastname", "last").replace("surname", "last")
    t = t.replace("givenname", "first").replace("+", "")
    return _PATTERN_NAMES.get(t)


def infer_shapes(known: list[str], prefer: list[str] | None = None) -> list[str]:
    """Shapes to try, the company's own first: what was learned or found for it, then separators seen in its public addresses
    (first.last, first_last, first-last), then the common ones. Cut forms of the best shapes come last, since they only differ for long names."""
    seen = []
    for addr in known:
        local = addr.split("@")[0].lower()
        for sep, shape in ((".", "first.last"), ("_", "first_last"), ("-", "first-last")):
            a, _, b = local.partition(sep)
            if sep in local and len(a) > 1 and len(b) > 1 and a.isalpha() and b.isalpha() and local not in set(cfg()["generic"]):
                seen.append(shape)
    ranked = list(dict.fromkeys([*(prefer or []), *sorted(set(seen), key=lambda x: -seen.count(x))]))
    out = ranked + [x for x in _ORDER if x not in ranked]
    cut = [f"{b}:{n}" for b in dict.fromkeys(x.split(":")[0] for x in out[:3]) for n in _TRUNC]
    return out + [c for c in cut if c not in out]


def candidates(name: str, domain: str, known: list[str] | None = None, prefer: list[str] | None = None, limit: int = 13) -> list[dict]:
    """Likely addresses: every shape, the company's own first, each local part once. limit fits the probe cap (max_probes minus the control)."""
    out: list[dict] = []
    seen: set[str] = set()
    for shape in infer_shapes(known or [], prefer):
        lp = local_part(name, shape)
        if lp and lp not in seen:
            seen.add(lp)
            out.append({"address": f"{lp}@{domain}", "shape": shape})
        if len(out) >= limit:
            break
    return out


def _verdict(code: int | None, reply: str) -> str:
    if code is None:
        return "unreachable"
    if code in (250, 251):
        return "accepted"
    if 400 <= code < 500:
        return "temporary"
    if _BLOCK.search(reply) and not _UNKNOWN.search(reply):
        return "blocked"
    return "rejected"


def _session(host: str, addresses: list[str], helo: str, timeout: float) -> dict[str, tuple[int | None, str]]:
    """One SMTP conversation: RCPT for every address, RSET between them, QUIT at the end. No DATA is ever sent."""
    out: dict[str, tuple[int | None, str]] = {}
    try:
        s = smtp_factory(host, 25, local_hostname=helo or None, timeout=timeout)
    except (OSError, smtplib.SMTPException) as e:
        return {a: (None, str(e)[:80]) for a in addresses}
    try:
        s.ehlo()
        for i, addr in enumerate(addresses):
            if i:
                sleep(cfg()["delay_seconds"])
                s.rset()
            code, _ = s.mail("")  # the null sender: this is a check, not a message
            if code != 250:
                out[addr] = (code, "sender refused")
                continue
            code, msg = s.rcpt(addr)
            out[addr] = (code, msg.decode(errors="replace") if isinstance(msg, bytes) else str(msg))
    except (OSError, smtplib.SMTPException) as e:
        for a in addresses:
            out.setdefault(a, (None, str(e)[:80]))
    finally:
        try:
            s.quit()
        except Exception:
            pass
    return out


def verify(domain: str, addresses: list[str]) -> dict:
    """{"domain", "provider", "policy", "catch_all", "results": {address: verdict}, "probes"} for at most mail.max_probes addresses."""
    c = cfg()
    hosts = mail_hosts(domain)
    info = {"domain": domain, "hosts": hosts[:3], "provider": provider(hosts), "policy": policy(domain) if hosts else {"spf": False, "dmarc": "missing"},
            "catch_all": None, "results": {}, "probes": 0}
    if not hosts:
        info["results"] = {a: "no-mail-server" for a in addresses}
        return info
    todo = addresses[: int(c["max_probes"])]
    for a in addresses[len(todo):]:
        info["results"][a] = "skipped"
    control = "".join(random.choices(string.ascii_lowercase, k=14)) + f"@{domain}"
    helo = c["helo"] or socket.getfqdn()
    raw: dict[str, tuple[int | None, str]] = {}
    for host in hosts[:2]:  # the best server, then one more when it cannot be reached
        raw = _session(host, [control, *todo], helo, float(c["timeout"]))
        if raw.get(control, (None, ""))[0] is not None:
            break
    info["probes"] = len(raw)
    ctrl = _verdict(*raw.get(control, (None, "")))
    info["catch_all"] = True if ctrl == "accepted" else (False if ctrl == "rejected" else None)
    for a in todo:
        v = _verdict(*raw.get(a, (None, "")))
        if v == "accepted" and ctrl == "accepted":
            v = "catch-all"      # the server says yes to anything, so this yes proves nothing
        elif v == "accepted" and ctrl != "rejected":
            v = "accepted-unconfirmed"  # no clean control to compare with (greylisting, blocked control)
        info["results"][a] = v
    return info


_BAND = ("low", "medium", "high")


def risk(verdict: str, prov: str, pol: dict, address: str) -> dict:
    """Rule-of-thumb bands for a first cold email to this address. An estimate from what the check saw, not a measured chance."""
    local = address.split("@")[0].lower()
    shared = local in set(cfg()["generic"])
    bounce, bwhy = {"accepted": (0, "the server accepted this exact address"), "rejected": (3, "the server said this mailbox does not exist"),
                    "catch-all": (1, "the server accepts any address, so a wrong guess is not caught here"),
                    "accepted-unconfirmed": (1, "accepted, but the control address could not be compared"),
                    "temporary": (1, "the server asked to retry later (greylisting), so nothing is confirmed"),
                    "blocked": (2, "the server refused the check itself (policy or reputation)"),
                    "unreachable": (1, "port 25 or the server did not answer"), "no-mail-server": (3, "the domain publishes no mail server"),
                    "skipped": (1, "not checked")}.get(verdict, (1, "unknown"))
    spam_pts, swhy = 0, []
    if prov in _GATEWAYS:
        spam_pts += 1
        swhy.append(f"mail goes through a filtering gateway ({prov})")
    if shared:
        spam_pts += 1
        swhy.append("a shared inbox: several people and filters see it")
    if verdict == "catch-all":
        spam_pts += 1
        swhy.append("catch-all domains often collect mail in a rarely read box")
    if bounce >= 2:
        spam_pts += 2
        swhy.append("sending to a dead or refusing address hurts the sender's reputation")
    if pol.get("dmarc") == "reject" and not shared:
        swhy.append("the domain enforces DMARC, so send from a properly authenticated address")
    return {"bounce": {"band": _BAND[min(bounce, 2)], "why": bwhy},
            "spam": {"band": _BAND[min(spam_pts, 2)], "why": swhy or ["no extra signal on the recipient side"]},
            "note": "A rule-of-thumb estimate from this check, not a measured probability. Your own sending address, attachments and links matter too."}


def find(name: str, domain: str, known: list[str] | None = None, prefer: list[str] | None = None) -> dict:
    """Candidate addresses for a person (every shape), checked, best first. `prefer` is the shape that worked for this company before."""
    cands = candidates(name, domain, known, prefer)
    return _rank(cands, verify(domain, [c["address"] for c in cands]))


def find_multi(name: str, domains: list[str], known: list[str] | None = None, prefer: list[str] | None = None, first_probes: int = 3) -> dict:
    """A company may mail from a different domain than its website (gs.com, not goldmansachs.com). The likeliest few patterns are tried on
    each domain; the first domain whose server accepts one is the company's, and the rest of the patterns are tried there only."""
    domains = list(dict.fromkeys(d for d in domains if d))[:3]
    if len(domains) <= 1:
        return {**find(name, domains[0], known, prefer), "domains_tried": domains} if domains else {"rows": [], "domains_tried": []}
    per: list[tuple[str, list[dict], dict]] = []
    chosen = None
    for d in domains:
        cands = candidates(name, d, known, prefer)
        info = verify(d, [c["address"] for c in cands[:first_probes]])
        per.append((d, cands, info))
        if any(v in ("accepted", "accepted-unconfirmed") for v in info["results"].values()):
            chosen = len(per) - 1
            break
    if chosen is None:
        chosen = 0  # nobody confirmed anything: go deep on the first domain (the best ranked)
    d, cands, info = per[chosen]
    rest = cands[first_probes:]
    if rest:
        more = verify(d, [c["address"] for c in rest])
        info = {**info, "results": {**info["results"], **more["results"]}, "probes": info["probes"] + more["probes"], "catch_all": more["catch_all"] if more["catch_all"] is not None else info["catch_all"]}
        per[chosen] = (d, cands, info)
    rows = []
    for dom, cs, inf in per:
        rows += _rank(cs[: len(inf["results"])] if dom != d else cs, inf)["rows"]
    rows.sort(key=lambda r: _ORDER_V.get(r["verdict"], 4))
    return {"domain": d, "provider": info["provider"], "policy": info["policy"], "catch_all": info["catch_all"], "hosts": info["hosts"],
            "probes": sum(i["probes"] for _, _, i in per), "rows": rows, "domains_tried": [x[0] for x in per]}


def generic(domain: str) -> dict:
    cands = [{"address": f"{g}@{domain}", "shape": "generic"} for g in cfg()["generic"]]
    return _rank(cands, verify(domain, [c["address"] for c in cands]))


_ORDER_V = {"accepted": 0, "accepted-unconfirmed": 1, "catch-all": 2, "temporary": 3, "unreachable": 3, "skipped": 4, "blocked": 4, "rejected": 5, "no-mail-server": 6}


def _rank(cands: list[dict], info: dict) -> dict:
    rows = []
    for c in cands:
        v = info["results"].get(c["address"], "skipped")
        rows.append({**c, "verdict": v, "risk": risk(v, info["provider"], info["policy"], c["address"])})
    rows.sort(key=lambda r: _ORDER_V.get(r["verdict"], 4))  # stable: the likelier shape stays first within a verdict
    return {"domain": info["domain"], "provider": info["provider"], "policy": info["policy"], "catch_all": info["catch_all"],
            "hosts": info["hosts"], "probes": info["probes"], "rows": rows}
