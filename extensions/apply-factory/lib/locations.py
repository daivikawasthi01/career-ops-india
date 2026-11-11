"""
Which job locations clearly lie outside India, so those jobs can be hidden and removed.

The test is one-sided on purpose (see tools/locations.mjs): a location counts only when it names a foreign country, US state or well-known
foreign city and nothing Indian. Unknown places stay, because no list of Indian towns is complete and a wrongly deleted job is worse
than a stray one. If the helper cannot run, nothing is reported and nothing is hidden or deleted.
"""
from __future__ import annotations

import json
import subprocess
from typing import Callable, Iterable

from . import config

HELPER = config.ROOT / "tools" / "locations.mjs"


def _run_node(locations: list[str]) -> list[str]:
    """The outside-world seam. Tests replace this name."""
    r = subprocess.run(["node", str(HELPER)], input=json.dumps(locations), capture_output=True, text=True, timeout=60, cwd=config.CAREEROPS)
    if r.returncode != 0:
        raise OSError(r.stderr.strip()[-200:] or "locations helper failed")
    return json.loads(r.stdout or "[]")


run_node: Callable[[list[str]], list[str]] = _run_node
_LAST: dict = {"key": None, "out": set()}   # one search after another asks about the same locations: answer once


def foreign(locations: Iterable[str]) -> set[str]:
    distinct = sorted({str(x or "").strip() for x in locations} - {""})
    try:
        mtime = (config.CAREEROPS / "portals.yml").stat().st_mtime   # the Indian cities come from your location_filter
    except OSError:
        mtime = 0
    key = (mtime, tuple(distinct))
    if _LAST["key"] == key:
        return _LAST["out"]
    try:
        out = set(run_node(distinct))
    except (OSError, ValueError, subprocess.SubprocessError):
        return set()
    _LAST.update(key=key, out=out)
    return out
