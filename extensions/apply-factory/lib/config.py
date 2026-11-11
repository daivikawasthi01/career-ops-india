"""config.yaml loader shared by the orchestrator, the server and the model backends."""
from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent      # extensions/apply-factory/
CAREEROPS = ROOT.parent.parent                     # career-ops/


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


LOCAL = ROOT / "config.local.yaml"   # one person's settings (key numbers, CV file names, home region); never shared, written by the setup wizard


@lru_cache(maxsize=1)
def load() -> dict:
    base = yaml.safe_load((ROOT / "config.yaml").read_text())
    return _merge(base, (yaml.safe_load(LOCAL.read_text()) or {}) if LOCAL.exists() else {})


def set_local(values: dict) -> None:
    """Merge settings into config.local.yaml and reload. Comments in that file are not kept; it is generated."""
    cur = (yaml.safe_load(LOCAL.read_text()) or {}) if LOCAL.exists() else {}
    LOCAL.write_text("# This computer's settings. Written by the setup wizard; safe to edit by hand.\n" + yaml.safe_dump(_merge(cur, values), sort_keys=False, allow_unicode=True))
    load.cache_clear()


def venv_python(venv: Path) -> Path:
    """The python inside a virtual environment folder, on macOS or Windows."""
    return venv / "Scripts" / "python.exe" if os.name == "nt" else venv / "bin" / "python"


def home_region() -> str:
    return str((load().get("company") or {}).get("home_region") or "").strip()


def path(key: str, section: str = "paths") -> Path:
    """A path from config.yaml, resolved against this folder."""
    return (ROOT / load()[section][key]).resolve()


def env(name: str) -> str | None:
    """An env var, falling back to career-ops' .env so Groq keys are shared with the scanners."""
    import os
    if os.environ.get(name):
        return os.environ[name]
    placeholder = re.compile(r"your[_ -]|paste|here$|^xxx|changeme", re.I)   # .env.example's sample values are not keys
    dotenv = CAREEROPS / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            if line.startswith(f"{name}=") and line.split("=", 1)[1].strip():
                value = line.split("=", 1)[1].strip().strip('"\'')
                return None if placeholder.search(value) else value
    return None
