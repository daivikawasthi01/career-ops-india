"""One seam for calling career-ops' own node scripts, so tests can replace it and no argument ever reaches a shell."""
from __future__ import annotations

import shutil
import subprocess

from . import config


def node() -> str:
    return shutil.which("node") or "/opt/homebrew/bin/node"


def run(args: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """(returncode, stdout, stderr) of `node <args>` run from the career-ops root. Never raises for a failing script."""
    try:
        r = subprocess.run([node(), *args], cwd=config.CAREEROPS, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except FileNotFoundError:
        return 127, "", "node is not installed"
