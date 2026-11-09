"""Canonical URLs and the fuzzy cross-source key.

canonical_url(url) is an identity: two URLs for the same posting give the same string.
For LinkedIn, Indeed and Greenhouse-style ATS URLs it is also a working link. For Naukri it
is an identity only (the id), so the stored link stays the original URL.
"""
import json
import re
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "dedup.json"
_cfg = None


def config():
    global _cfg
    if _cfg is None:
        _cfg = json.loads(CONFIG_PATH.read_text())
    return _cfg


def host_of(url):
    return (urlparse(url or "").hostname or "").lower().removeprefix("www.")


def host_matches(host, domains):
    return any(host == d or host.endswith("." + d) for d in domains)


def canonical_url(url):
    raw = str(url or "").strip()
    if not raw:
        return ""
    try:
        u = urlparse(raw if "//" in raw else "https://" + raw)
    except ValueError:
        return raw.lower()
    host = (u.hostname or "").lower().removeprefix("www.")
    path = u.path.rstrip("/")
    q = dict(parse_qsl(u.query, keep_blank_values=False))

    if host_matches(host, ["linkedin.com"]):
        m = re.search(r"/jobs/view/(?:[^/]*-)?(\d{6,})", path)
        job_id = m.group(1) if m else q.get("currentJobId")
        if job_id:
            return f"https://www.linkedin.com/jobs/view/{job_id}"
    if host_matches(host, ["indeed.com"]):
        jk = q.get("jk") or q.get("vjk")
        if jk:
            return f"https://www.indeed.com/viewjob?jk={jk}"
    if host_matches(host, ["naukri.com"]):
        m = re.search(r"-(\d{9,})$", path)
        if m:
            return f"https://www.naukri.com/job-listings-{m.group(1)}"
    if host_matches(host, ["greenhouse.io"]):
        jid = q.get("gh_jid")
        m = re.match(r"/([^/]+)/jobs/(\d+)", path)
        if m:
            return f"https://boards.greenhouse.io/{m.group(1).lower()}/jobs/{m.group(2)}"
        if jid and path:
            return f"https://boards.greenhouse.io{path.lower()}?gh_jid={jid}"
    if host_matches(host, ["lever.co"]):
        path = re.sub(r"/apply$", "", path)
    if host_matches(host, ["ashbyhq.com"]):
        path = re.sub(r"/application$", "", path)

    drop = set(config()["tracking_params"])
    kept = sorted((k, v) for k, v in q.items() if k.lower() not in drop and not k.lower().startswith("utm_"))
    query = urlencode(kept)
    return f"https://{host}{path}" + (f"?{query}" if query else "")


def _fold(text):
    text = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower())


def company_key(name):
    drop = set(config()["company_suffixes"])
    all_words = _fold(name).split()
    words = [w for w in all_words if w not in drop]
    return " ".join(words or all_words)  # "Tech Mahindra" must not become empty


def title_tokens(title):
    text = re.sub(r"[\(\[][^\)\]]*[\)\]]", " ", str(title or ""))  # (2027 batch), [Remote]
    noise = set(config()["title_noise"])
    return sorted({w for w in _fold(text).split() if w not in noise and not re.fullmatch(r"20\d\d", w)})


def title_key(title):
    return " ".join(title_tokens(title))


def city_key(location):
    """The first named place in a location, or '' when it is generic (India, Remote, empty)."""
    cfg = config()
    first = re.split(r"[,/;|\(\)]| - | or ", str(location or ""))[0]
    place = " ".join(_fold(first).split())
    if not place or place in cfg["generic_locations"]:
        return ""
    return cfg["city_aliases"].get(place, place)


def fuzzy_key(company, title, location):
    """company|title|city, or None when there is not enough to match on (no company, title or specific city)."""
    c, t, city = company_key(company), title_key(title), city_key(location)
    return f"{c}|{t}|{city}" if c and t and city else None
