"""config.yaml loader shared by the orchestrator, the server and the model backends."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent      # extensions/apply-factory/
CAREEROPS = ROOT.parent.parent                     # career-ops/


@lru_cache(maxsize=1)
def load() -> dict:
    return yaml.safe_load((ROOT / "config.yaml").read_text())


def path(key: str, section: str = "paths") -> Path:
    """A path from config.yaml, resolved against this folder."""
    return (ROOT / load()[section][key]).resolve()


def env(name: str) -> str | None:
    """An env var, falling back to career-ops' .env so Groq keys are shared with the scanners."""
    import os
    if os.environ.get(name):
        return os.environ[name]
    dotenv = CAREEROPS / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            if line.startswith(f"{name}=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip().strip('"\'')
    return None
