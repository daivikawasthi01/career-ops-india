"""A macOS LaunchAgent so the local server is already running when the browser opens."""
from __future__ import annotations

import plistlib
import subprocess
from pathlib import Path

from . import config

LABEL = "in.career-ops.apply-factory"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def plist_bytes() -> bytes:
    py = config.ROOT / ".venv" / "bin" / "python"
    log = config.ROOT / "data" / "server.log"
    return plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [str(py), str(config.ROOT / "orchestrator.py"), "serve"],
        "WorkingDirectory": str(config.ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "StandardOutPath": str(log),
        "StandardErrorPath": str(log),
    })


def install(load: bool) -> str:
    (config.ROOT / "data").mkdir(exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plist_bytes())
    if load:
        subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
        subprocess.run(["launchctl", "load", "-w", str(PLIST)], check=True)
        return f"installed and started: {PLIST}"
    return f"written (not started): {PLIST}\nstart it with: launchctl load -w {PLIST}"


def uninstall() -> str:
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
    return "removed"
