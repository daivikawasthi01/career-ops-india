#!/usr/bin/env python3
"""
Generates manifest.json (content-script matches come from rules/rules.json, so the sites list lives in one place)
and the toolbar icons. Run after editing rules.json:  python browser/build.py
"""
from __future__ import annotations

import json
import subprocess
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from lib import config, rules  # noqa: E402

CONTENT_FILES = ["content/core.js", "content/widgets.js", "content/capture.js", "content/suggest.js", "content/main.js"]


def match_patterns() -> list[str]:
    """Every https page when generic detection is on (the script stays inert off application pages), else the listed sites."""
    r = rules.load()
    if r["generic"]["enabled"]:
        return ["https://*/*"]
    sites = list(r["ats_sites"]) + [h for h, m in r["guarded_sites"].items() if m == "watch"]
    out = []
    for s in sites:
        host, _, path = s.partition("/")
        out.append(f"https://{host}/{path}/*" if path else f"https://*.{host}/*")
    return sorted(set(out))


def manifest() -> dict:
    port = config.load()["server"]["port"]
    return {
        "manifest_version": 3,
        "name": "Apply",
        "version": "0.8.0",
        "description": "Fills job application forms from your earlier answers and learns new ones. Acts only on application pages. Never presses Submit.",
        "minimum_chrome_version": "114",
        "icons": {str(n): f"icons/{n}.png" for n in (16, 32, 48, 128)},
        "action": {"default_title": "Apply", "default_icon": {str(n): f"icons/{n}.png" for n in (16, 32)}},
        "side_panel": {"default_path": "app/panel.html"},
        "background": {"service_worker": "background.js"},
        "permissions": ["storage", "sidePanel", "scripting", "tabs", "webNavigation", "activeTab"],
        "host_permissions": [f"http://127.0.0.1:{port}/*"],
        "optional_host_permissions": ["https://*/*"],
        "web_accessible_resources": [{"resources": ["app/*"], "matches": ["https://*/*"], "use_dynamic_url": True}],  # the in-page copy of the panel; the address changes per session, so a web page cannot frame it on its own
        "content_scripts": [{"matches": match_patterns(), "js": CONTENT_FILES, "run_at": "document_idle", "all_frames": True}],
    }


# ---- icons: a rounded zinc square with a white check mark, drawn with 4x supersampling ----
BASE = (24, 24, 27)      # shadcn zinc 900
MARK = (250, 250, 250)  # zinc 50


def _icon(n: int) -> bytes:
    ss = 4
    big = n * ss
    px = [[(0, 0, 0, 0)] * n for _ in range(n)]
    r = big * 0.22

    def inside(x, y):
        cx, cy = min(max(x, r), big - r), min(max(y, r), big - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

    def on_check(x, y):
        pts = [(0.27, 0.53), (0.43, 0.69), (0.74, 0.34)]
        w = 0.085 * big
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            ax, ay, bx, by = ax * big, ay * big, bx * big, by * big
            dx, dy = bx - ax, by - ay
            t = max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            if (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= w * w:
                return True
        return False

    for j in range(n):
        for i in range(n):
            a = c = 0
            for sj in range(ss):
                for si in range(ss):
                    x, y = i * ss + si + 0.5, j * ss + sj + 0.5
                    if inside(x, y):
                        a += 1
                        c += 1 if on_check(x, y) else 0
            if a:
                k = c / a
                px[j][i] = tuple(round(BASE[m] * (1 - k) + MARK[m] * k) for m in range(3)) + (round(255 * a / (ss * ss)),)
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in px)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def build_ui() -> None:
    """The side panel and the CV studio are a React + shadcn app in ../ui, built into browser/app. Skipped when its packages are not installed."""
    ui = HERE.parent / "ui"
    if not (ui / "node_modules").exists():
        print("ui/node_modules is missing: run `npm install` in ui/ to build the panel and studio")
        return
    subprocess.run(["npm", "run", "build", "--silent"], cwd=ui, check=True)


def main() -> None:
    (HERE / "manifest.json").write_text(json.dumps(manifest(), indent=2) + "\n")
    (HERE / "icons").mkdir(exist_ok=True)
    for n in (16, 32, 48, 128):
        (HERE / "icons" / f"{n}.png").write_bytes(_icon(n))
    build_ui()
    server_cmd = "./apply start"   # the same for everyone: no path of the builder's Mac in a file other people receive
    (HERE / "app").mkdir(exist_ok=True)
    (HERE / "app" / "config.js").write_text(f"// generated by browser/build.py\nwindow.AF_SERVER_CMD = {json.dumps(server_cmd)};\nwindow.AF_BUILD = {json.dumps(manifest()['version'])};\n")
    print(f"wrote manifest.json ({len(match_patterns())} site patterns) and icons")


if __name__ == "__main__":
    main()
