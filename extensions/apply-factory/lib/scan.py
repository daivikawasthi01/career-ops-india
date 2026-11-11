"""Find jobs now: runs the job scanners (tools/mine.py) in the background and reports progress for the Jobs tab.

One run at a time. The scanner's own output is kept in data/scan.log; the panel only sees the last line and whether it finished.
"""
from __future__ import annotations

import re
import subprocess
import threading
import time

from . import config

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
LOG = config.ROOT / "data" / "scan.log"
_STATE = {"running": False, "started": 0.0, "finished": 0.0, "ok": None, "line": "", "error": ""}
_LOCK = threading.Lock()


def _python() -> str:
    venv = config.venv_python(config.CAREEROPS / "tools" / ".venv-jobspy")
    return str(venv) if venv.exists() else ("python" if config.os.name == "nt" else "python3")


def can_scan() -> str:
    """Empty when ready, else what is missing, in words a person can act on."""
    if not (config.CAREEROPS / "tools" / "mine.py").exists():
        return "The job scanner is not in this folder."
    if not config.venv_python(config.CAREEROPS / "tools" / ".venv-jobspy").exists():
        return "The job scanner is not installed yet. Run the install command again (./apply install on a Mac, .\\apply.ps1 install on Windows)."
    if not (config.CAREEROPS / "data" / "pipeline.user.yml").exists() and not (config.CAREEROPS / "config" / "pipeline.yml").exists():
        return "Tell Apply what jobs to look for first (You tab, Job search)."
    return ""


def start() -> dict:
    why = can_scan()
    if why:
        return {"error": why}
    with _LOCK:
        if _STATE["running"]:
            return status()
        _STATE.update(running=True, started=time.time(), finished=0.0, ok=None, line="Starting", error="")
    threading.Thread(target=_run, daemon=True).start()
    return status()


def _run() -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    ok, err = False, ""
    try:
        with LOG.open("w") as log:
            proc = subprocess.Popen([_python(), str(config.CAREEROPS / "tools" / "mine.py"), "--no-slow"], cwd=config.CAREEROPS,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in proc.stdout or []:
                log.write(line)
                log.flush()
                # tqdm redraws one progress line with carriage returns and cursor escapes; show only its newest state
                last = [p.strip() for p in _ANSI.sub("", line).split("\r") if p.strip()]
                if last:
                    _STATE["line"] = last[-1][:140]
            ok = proc.wait() in (0, 3)   # 3 = a source was degraded, the rest worked (see tools/schedule/README.md)
            if not ok:
                err = "The scan stopped with an error. The last lines are in extensions/apply-factory/data/scan.log."
    except OSError as e:
        err = f"Could not start the scanner: {e}"
    with _LOCK:
        _STATE.update(running=False, finished=time.time(), ok=ok, error=err)


def status() -> dict:
    return {**_STATE, "can": can_scan() == "", "why": can_scan()}
