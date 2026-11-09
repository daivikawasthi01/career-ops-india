"""Read config/pipeline.yml from Python. Node already has a YAML reader, so ask it for JSON once."""
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_cache = {}

_SCRIPT = ("import {loadYaml} from './lib/yaml-document.mjs'; import {readFileSync} from 'fs';"
           "console.log(JSON.stringify(loadYaml(readFileSync(process.argv[1],'utf8'))))")


def config_path():
    return Path(os.environ.get("CAREER_OPS_PIPELINE_CONFIG") or ROOT / "config" / "pipeline.yml")


def load():
    path = str(config_path())
    if path not in _cache:
        out = subprocess.run(["node", "--input-type=module", "-e", _SCRIPT, path], cwd=ROOT,
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            raise RuntimeError(f"cannot read {path}: {out.stderr.strip()[:200]}")
        _cache[path] = json.loads(out.stdout)
    return _cache[path]


def section(name, default=None):
    return load().get(name, default if default is not None else {})
