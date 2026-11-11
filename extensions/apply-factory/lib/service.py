"""Start the local server at login so it is already running when the browser opens: a LaunchAgent on macOS, a Startup-folder script on Windows."""
from __future__ import annotations

import os
import plistlib
import subprocess
from pathlib import Path

from . import config

LABEL = "in.career-ops.apply-factory"
PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"


def plist_bytes() -> bytes:
    py = config.venv_python(config.ROOT / ".venv")
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


STARTUP_SCRIPT = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup" / "Apply helper.vbs"


def _windows_launch() -> list[str]:
    return [str(config.venv_python(config.ROOT / ".venv")), str(config.ROOT / "orchestrator.py"), "serve"]


def _install_windows(load: bool) -> str:
    (config.ROOT / "data").mkdir(exist_ok=True)
    cmd = " ".join(f'""{a}""' for a in _windows_launch())
    STARTUP_SCRIPT.parent.mkdir(parents=True, exist_ok=True)
    # a one-line script that starts the helper with no console window each time you log in
    STARTUP_SCRIPT.write_text(f'CreateObject("WScript.Shell").CurrentDirectory = "{config.ROOT}"\nCreateObject("WScript.Shell").Run "{cmd}", 0, False\n')
    if load:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        subprocess.Popen(_windows_launch(), cwd=str(config.ROOT), creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        return f"installed and started: {STARTUP_SCRIPT}"
    return f"written (not started): {STARTUP_SCRIPT}"


def install(load: bool) -> str:
    if os.name == "nt":
        return _install_windows(load)
    (config.ROOT / "data").mkdir(exist_ok=True)
    PLIST.parent.mkdir(parents=True, exist_ok=True)
    PLIST.write_bytes(plist_bytes())
    if load:
        subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
        subprocess.run(["launchctl", "load", "-w", str(PLIST)], check=True)
        return f"installed and started: {PLIST}"
    return f"written (not started): {PLIST}\nstart it with: launchctl load -w {PLIST}"


def uninstall() -> str:
    if os.name == "nt":
        STARTUP_SCRIPT.unlink(missing_ok=True)
        return "removed (stop a running helper with .\\apply.ps1 stop)"
    subprocess.run(["launchctl", "unload", str(PLIST)], capture_output=True)
    PLIST.unlink(missing_ok=True)
    return "removed"
