"""Run the internshala-scraper API bound to 127.0.0.1 only.

The upstream run.py binds 0.0.0.0, which exposes the scraper to everything on the same network.
This wrapper reuses the scraper's own app and routes (nothing in that clone is edited) and listens on loopback.
Run with the scraper's venv python and its directory as cwd (scan-internshala.mjs does this):
    cd internshala-scraper && .venv/bin/python ../career-ops/tools/internshala_serve.py
"""
import os
import signal
import sys

sys.path.insert(0, os.getcwd())

import bottle  # noqa: E402
from cheroot import wsgi  # noqa: E402

import config  # noqa: E402
import routes  # noqa: E402,F401  (mounts the routes on bottle's default app)


def main():
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    server = wsgi.Server(("127.0.0.1", config.PORT), bottle.default_app(), server_name="internshala-scraper", numthreads=16)
    print(f"Internshala Scraper listening on http://127.0.0.1:{config.PORT}/ (loopback only)", flush=True)
    try:
        server.start()
    except KeyboardInterrupt:
        pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()
