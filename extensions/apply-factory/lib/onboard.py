"""First-run setup from the side panel: model keys, the CV as text, and what jobs to search for.

Everything a new person would otherwise edit by hand (.env, cv.md, config/profile.yml, portals.yml, a pipeline filter file) is written here
from a few form answers. Keys are only ever written, never returned: the panel sees how many there are, not what they are.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

import yaml

import base64

from . import account, config, llm, profile, resume

REPO = config.ROOT.parent.parent   # the career-ops checkout the scripts live in; user files go to config.CAREEROPS, which a test points elsewhere


def _env_file() -> Path:
    return config.CAREEROPS / ".env"


def _user_pipeline() -> Path:
    return config.CAREEROPS / "data" / "pipeline.user.yml"


def _mark() -> Path:   # exists once the wizard has written profile.yml / portals.yml, so a later save may replace them
    return config.CAREEROPS / "data" / ".apply-setup"

PROVIDERS = {
    "groq": {"label": "Groq", "link": "https://console.groq.com/keys", "base": "GROQ_API_KEY", "max": 9,
             "check": "https://api.groq.com/openai/v1/models", "auth": "bearer"},
    "gemini": {"label": "Gemini", "link": "https://aistudio.google.com/apikey", "base": "GEMINI_API_KEY", "max": 10,
               "check": "https://generativelanguage.googleapis.com/v1beta/models", "auth": "query"},
}


# ---- the .env file ----
def _names(provider: str) -> list[str]:
    p = PROVIDERS[provider]
    return [p["base"]] + [f"{p['base']}_{i}" for i in range(2, p["max"] + 1)]


def _read_env() -> list[str]:
    return _env_file().read_text().splitlines() if _env_file().exists() else []


def env_set(name: str, value: str) -> None:
    """Set one variable in place (keeping every other line), owner-only permissions, and make the running server see it."""
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name) or "\n" in value:
        raise ValueError("bad variable")
    lines = _read_env()
    pat = re.compile(rf"^{re.escape(name)}\s*=")
    hit = next((i for i, ln in enumerate(lines) if pat.match(ln)), None)
    line = f"{name}={value}"
    if hit is None:
        lines.append(line)
    else:
        lines[hit] = line
    _env_file().write_text("\n".join(lines) + "\n")
    _env_file().chmod(0o600)
    os.environ[name] = value
    llm._pool.cache_clear()


def keys_status() -> dict:
    """How many keys each provider has, the most it allows, and the last four characters of each so a key can be told apart. Never the keys."""
    out = {}
    for provider, p in PROVIDERS.items():
        found = [(n, config.env(n)) for n in _names(provider) if config.env(n)]
        out[provider] = {"label": p["label"], "link": p["link"], "count": len(found), "max": p["max"],
                         "keys": [{"name": n, "tail": v[-4:]} for n, v in found]}
    return out


def remove_key(provider: str, name: str) -> dict:
    """Take one key out of .env (its line is deleted). Only a name this provider could have written is accepted."""
    if provider not in PROVIDERS or name not in _names(provider):
        raise ValueError("unknown key")
    lines = [ln for ln in _read_env() if not re.match(rf"^{re.escape(name)}\s*=", ln)]
    _env_file().write_text("\n".join(lines) + ("\n" if lines else ""))
    os.environ.pop(name, None)
    llm._pool.cache_clear()
    return {"ok": True, "keys": keys_status()}


# The one outside call, kept in a seam so tests do not need the internet.
def _http_get(url: str, headers: dict) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "apply-factory/0.7", **headers})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


fetch: Callable[[str, dict], int] = _http_get


def save_key(provider: str, key: str) -> dict:
    """Check the key with the provider, and only then store it. A second key for the same provider is added beside the first, which spreads the free limits."""
    if provider not in PROVIDERS:
        raise ValueError("unknown provider")
    key = key.strip().strip("\"'")
    if not re.fullmatch(r"[A-Za-z0-9_\-]{20,200}", key):
        raise ValueError("That does not look like a key. Copy the whole key from the provider's page, with nothing before or after it.")
    p = PROVIDERS[provider]
    url, headers = p["check"], {}
    if p["auth"] == "bearer":
        headers["Authorization"] = f"Bearer {key}"
    else:
        url += f"?key={key}"
    try:
        code = fetch(url, headers)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ValueError(f"Could not reach {p['label']}. Check your internet connection and try again.")
    if code in (400, 401, 403):
        raise ValueError(f"{p['label']} did not accept that key. Make sure you copied all of it.")
    if code >= 500 or code == 0:
        raise ValueError(f"{p['label']} is not answering right now. Try again in a minute.")
    names = _names(provider)
    existing = {n: config.env(n) for n in names}
    if key in existing.values():
        return {"ok": True, "added": False, "keys": keys_status()}
    free = next((n for n in names if not existing[n]), None)
    if not free:
        raise ValueError(f"You already have {len(names)} {p['label']} keys, which is the most Apply uses.")
    env_set(free, key)
    return {"ok": True, "added": True, "keys": keys_status()}


# ---- the CV as text ----
def cv_path() -> Path:
    return config.path("cv", "paths_extra")


def cv_get() -> dict:
    p = cv_path()
    return {"text": p.read_text() if p.exists() else "", "exists": p.exists()}


def cv_set(text: str) -> dict:
    text = text.strip()
    if len(text) < 80:
        raise ValueError("That is too short to be a CV. Paste the whole text.")
    if len(text) > 60000:
        raise ValueError("That is too long for a CV.")
    p = cv_path()
    if p.exists():
        p.replace(p.with_suffix(".previous.md"))
    p.write_text(text + "\n")
    profile.reload()
    return {"ok": True}


def pdf_to_text(data: bytes) -> str:
    """The text layer of a PDF through poppler's pdftotext, tidied into plain paragraphs. Empty when the PDF is only a picture."""
    exe = shutil.which("pdftotext")
    if not exe:
        return ""
    out = subprocess.run([exe, "-layout", "-", "-"], input=data, capture_output=True, timeout=60)
    text = out.stdout.decode("utf-8", "replace")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ---- what to search for ----
LEVELS = {"student": "Student or new graduate", "entry": "Early career (0 to 2 years)", "mid": "Mid level (3 to 6 years)", "senior": "Senior (7 or more years)"}
_SENIOR_WORDS = {
    "student": ["word:senior", "word:sr", "word:lead", "word:principal", "stem:staff", "word:head", "stem:director", "word:manager", "word:vp", "word:architect", "word:ii", "word:iii", "word:iv"],
    "entry": ["word:senior", "word:sr", "word:lead", "word:principal", "stem:staff", "word:head", "stem:director", "word:manager", "word:vp", "word:architect", "word:iii", "word:iv"],
    "mid": ["word:principal", "stem:staff", "word:head", "stem:director", "word:vp", "word:architect", "word:iv"],
    "senior": ["stem:director", "word:vp", "word:intern", "word:junior", "word:jr", "stem:trainee"],
}
_ENTRY_ONLY = {"student", "entry"}
# Jobs tab: a title with one of these is "above your level" and hidden while "Hide jobs above my level" is on.
SENIOR_TITLE_WORDS = {
    "student": ["senior", "sr", "lead", "staff", "principal", "manager", "director", "head", "vp", "architect", "distinguished", "fellow"],
    "entry": ["senior", "sr", "lead", "staff", "principal", "manager", "director", "head", "vp", "architect", "distinguished", "fellow"],
    "mid": ["principal", "staff", "director", "head", "vp", "distinguished", "fellow"],
    "senior": ["director", "vp", "head", "distinguished", "fellow"],
}


def _list(v) -> list[str]:
    if isinstance(v, str):
        v = re.split(r"[\n,;]", v)
    return [re.sub(r"\s+", " ", str(x)).strip() for x in (v or []) if str(x).strip()][:30]


def role_keywords(roles: list[str]) -> list[str]:
    out: list[str] = []
    for r in roles:
        low = r.lower()
        out.append(low)
        if "engineer" in low:
            out.append(low.replace("engineer", "developer"))
        elif "developer" in low:
            out.append(low.replace("developer", "engineer"))
    return list(dict.fromkeys(out))


def search_get() -> dict:
    """What the form shows: the last saved answers, kept in config.local.yaml next to the settings they produce."""
    cur = (yaml.safe_load(config.LOCAL.read_text()) or {}) if config.LOCAL.exists() else {}
    s = cur.get("search") or {}
    return {"roles": s.get("roles", []), "avoid": s.get("avoid", []), "country": s.get("country", ""), "cities": s.get("cities", []),
            "level": s.get("level", ""), "years": s.get("years", ""), "levels": LEVELS, "saved": bool(s)}


def _pipeline_for(prefs: dict) -> dict:
    base = yaml.safe_load((REPO / "config" / "pipeline.yml").read_text())
    level, years, country = prefs["level"], float(prefs["years"] or 0), prefs["country"]
    roles = prefs["roles"]
    base["title_filter"]["positive"] = role_keywords(roles) + [k.lower() for k in prefs["keywords"]]
    base["title_filter"]["negative"] = list(dict.fromkeys(_SENIOR_WORDS[level] + [a.lower() for a in prefs["avoid"]]))
    base["title_filter"]["protect"] = []
    low = [r.lower() for r in roles]
    terms = list(dict.fromkeys(low + [f"junior {r}" for r in low] if level in _ENTRY_ONLY else low + ([f"senior {r}" for r in low] if level == "senior" else [])))
    base.setdefault("jobspy", {})["terms"] = terms
    base["batch_years"] = []                      # a graduation year filter only makes sense for the owner's own search
    base["max_min_experience_years"] = int(years) + 1
    base["seniority_guard"] = {"enabled": True, "flag_min_years": int(years) + 1, "drop_min_years": int(years) + 3}
    place = prefs["cities"][0] if prefs["cities"] else country
    base["search"] = {"location": f"{place}, {country}" if prefs["cities"] and country else (place or country), "country": country}
    india = country.strip().lower() == "india"
    base.setdefault("freshness", {})["drop_foreign_location"] = india
    if not india:   # Internshala and freehire list Indian jobs only
        base["steps"] = [s for s in base.get("steps", []) if s.get("id") not in ("freehire", "internshala")]
    return base


def _run_onboard_write(answers: dict, only: str, force: bool) -> dict:
    cmd = ["node", str(REPO / "onboard-write.mjs"), "--answers", "-", "--only", only, "--target", str(config.CAREEROPS)] + (["--force"] if force else [])
    out = subprocess.run(cmd, input=json.dumps(answers), capture_output=True, text=True, cwd=REPO, timeout=60)
    if out.returncode != 0:
        raise ValueError(f"Could not write the {only} file: {(out.stderr or out.stdout).strip()[:160]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def _timezone() -> str:
    """This Mac's time zone name (Europe/Berlin), from the /etc/localtime link; UTC when it cannot be read."""
    if os.name == "nt":
        return "UTC"   # Windows names its zones differently; the profile only needs a valid name
    try:
        return os.path.realpath("/etc/localtime").split("zoneinfo/")[-1] or "UTC"
    except OSError:
        return "UTC"


def _backup(p: Path) -> None:
    if p.exists():
        shutil.copy2(p, p.with_name(f"{p.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}"))


def search_set(raw: dict) -> dict:
    roles = _list(raw.get("roles"))
    if not roles:
        raise ValueError("Add at least one job title you are looking for.")
    level = str(raw.get("level") or "")
    if level not in LEVELS:
        raise ValueError("Choose the level you are applying at.")
    country = str(raw.get("country") or "").strip()
    if not country:
        raise ValueError("Say which country you are looking in.")
    try:
        years = float(str(raw.get("years") or "0").strip() or 0)
    except ValueError:
        raise ValueError("Years of experience should be a number.")
    if not 0 <= years <= 60:
        raise ValueError("Years of experience should be between 0 and 60.")
    prefs = {"roles": roles, "avoid": _list(raw.get("avoid")), "keywords": _list(raw.get("keywords")), "country": country,
             "cities": _list(raw.get("cities")), "level": level, "years": years}
    facts = profile.facts()
    # 1) the career-ops profile and portal list: written when they do not exist, or when this wizard wrote them before. A file you made by hand is kept.
    notes = []
    answers = {
        "candidate": {"full_name": facts.get("full_name") or "Candidate", "email": facts.get("email") or "candidate@example.com",
                      "location": ", ".join([*prefs["cities"][:1], country]), "years_of_experience": years},
        "target_roles": roles,
        "compensation": {"target_range": str(raw.get("pay") or "to be discussed"), "currency": "INR" if country.lower() == "india" else "USD"},
        "location": {"country": country, "timezone": _timezone(), "city": prefs["cities"][0] if prefs["cities"] else ""},
        "spend_tier": "standard",
        "portals": {"positive": role_keywords(roles), "negative": prefs["avoid"], "countries": [country], "cities": prefs["cities"]},
    }
    for only, p in (("profile", config.CAREEROPS / "config" / "profile.yml"), ("portals", config.CAREEROPS / "portals.yml")):
        if p.exists() and not _mark().exists():
            notes.append(f"Kept your existing {p.name}.")
            continue
        _backup(p)
        _run_onboard_write(answers, only, force=True)
    _mark().parent.mkdir(parents=True, exist_ok=True)
    _mark().write_text("written by the apply-factory setup wizard\n")
    # 2) the shared scanner filters, as this person's own copy
    _user_pipeline().parent.mkdir(parents=True, exist_ok=True)
    _user_pipeline().write_text("# Written by the Apply setup wizard from your answers. Delete this file to go back to config/pipeline.yml.\n"
                             + yaml.safe_dump(_pipeline_for(prefs), sort_keys=False, allow_unicode=True))
    # 3) this computer's settings
    fill_facts_from_search(country, prefs["cities"], years)
    config.set_local({"search": {k: prefs[k] for k in ("roles", "avoid", "country", "cities", "level", "years")},
                      "company": {"home_region": country, "default_locations": prefs["cities"][:3]},
                      "jobs": {"seniority_words": SENIOR_TITLE_WORDS[level]}})
    return {"ok": True, "notes": notes, "terms": len(_pipeline_for(prefs)["jobspy"]["terms"])}


def cv_upload(b64: str) -> dict:
    """Save the PDF as the default CV and read its text, so the CV text step starts filled in."""
    saved = resume.save("default", b64)
    text = pdf_to_text(base64.b64decode(b64))
    return {**saved, "text": text, "existing": cv_get()["exists"]}


def fill_facts_from_search(prefs_country: str, cities: list[str], years: float) -> None:
    """Details the search form already answered are not asked again."""
    have = profile.facts()
    add = {}
    if prefs_country and not have.get("country"):
        add["country"] = prefs_country
    if cities and not have.get("city"):
        add["city"] = cities[0]
    if "years_experience" not in have:
        add["years_experience"] = str(int(years))
    if add:
        account.set_facts(add)


def state() -> dict:
    """What the wizard needs to decide which step to show. No secrets."""
    return {"keys": keys_status(), "cv": {"exists": cv_get()["exists"]}, "search": search_get()}


def suggest_roles(roles_raw, level: str = "", country: str = "") -> dict:
    """More job titles and title words for the same kind of work, from the model, so the search does not stop at the three titles a person thought of.
    The person picks which to add; nothing is saved here."""
    roles = _list(roles_raw)
    if not roles:
        raise ValueError("Add at least one job title first.")
    cv = profile.cv_text()[:2500]
    prompt = (f"Job titles the person wants: {', '.join(roles)}\nLevel: {LEVELS.get(level, level) or 'not stated'}\nCountry: {country or 'not stated'}\n"
              + (f"Their CV (for the skills they have):\n{cv}\n" if cv else "") +
              "\nReturn JSON only: {\"titles\": [up to 14 other job titles that people with this background are hired for and that are really used on job boards, "
              "different from the ones given], \"keywords\": [up to 8 single words or short phrases that often appear in such titles or searches]}. "
              "Use plain, common titles. No seniority words unless the level asks for them.")
    raw = llm.call(prompt, system="You help someone search job boards. Reply with JSON only.", temperature=0.3, timeout=60)
    m = re.search(r"\{.*\}", raw, re.S)
    try:
        data = json.loads(m.group(0)) if m else {}
    except ValueError:
        data = {}
    have = {r.lower() for r in roles}
    clean = lambda xs, n: list(dict.fromkeys(re.sub(r"\s+", " ", str(x)).strip() for x in (xs or []) if 2 < len(str(x).strip()) < 60 and str(x).strip().lower() not in have))[:n]
    out = {"titles": clean(data.get("titles"), 14), "keywords": clean(data.get("keywords"), 8)}
    if not out["titles"] and not out["keywords"]:
        raise ValueError("The model did not give usable suggestions. Try again in a minute.")
    return out
