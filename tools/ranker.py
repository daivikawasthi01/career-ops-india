#!/usr/bin/env python3
"""OFFER, not enabled: a small ranker that only reorders a digest (Phase 9.5).

Needs at least `ranker.min_labels` labelled rows (interested/applied = good, ignore = not). Plain-Python logistic
regression on title words, source, city, stipend and company type. Nothing calls it automatically and it never filters a row.

  python3 tools/ranker.py status          # how many labels exist, and whether the offer is open
  python3 tools/ranker.py explain         # train in memory and say in words what it learned
  python3 tools/ranker.py rank            # print the new rows ordered by predicted interest (digest order only)
"""
import json
import math
import random
import re
import sys

import pipeline_cfg
import store
from canonical import city_key


def features(job):
    f = {"bias": 1.0}
    for w in set(re.findall(r"[a-z][a-z0-9+#.]{1,}", (job.get("title") or "").lower())):
        f["title:" + w] = 1.0
    for s in json.loads(job["found_by"]) if isinstance(job.get("found_by"), str) else (job.get("found_by") or []):
        f["source:" + s] = 1.0
    city = city_key(job.get("location"))
    f["city:" + (city or "unspecified")] = 1.0
    stip = str(job.get("stipend") or job.get("location") or "").lower()
    f["stipend:unpaid" if "unpaid" in stip else "stipend:other"] = 1.0
    f["company:" + ("employer-confirmed" if job.get("confidence") == "employer-confirmed" else "aggregator")] = 1.0
    return f


def train(rows, epochs=200, lr=0.1, l2=0.01, seed=0):
    """rows: [(features, label 0/1)]. Returns weights dict."""
    w, rng = {}, random.Random(seed)
    data = list(rows)
    for _ in range(epochs):
        rng.shuffle(data)
        for x, y in data:
            z = sum(w.get(k, 0.0) * v for k, v in x.items())
            p = 1 / (1 + math.exp(-max(min(z, 30), -30)))
            for k, v in x.items():
                w[k] = w.get(k, 0.0) - lr * ((p - y) * v + l2 * w.get(k, 0.0))
    return w


def score(w, job):
    z = sum(w.get(k, 0.0) * v for k, v in features(job).items())
    return 1 / (1 + math.exp(-max(min(z, 30), -30)))


def labelled(conn):
    out = []
    for r in conn.execute("SELECT * FROM jobs WHERE status IN ('interested','applied','ignore')"):
        d = dict(r)
        out.append((d, 1 if d["status"] in ("interested", "applied") else 0))
    return out


def explain(w, top=6):
    items = sorted(((k, v) for k, v in w.items() if k != "bias"), key=lambda kv: kv[1])
    name = lambda k: k.replace(":", " ")  # noqa: E731
    like = [f"{name(k)} ({v:+.1f})" for k, v in reversed(items[-top:]) if v > 0]
    dislike = [f"{name(k)} ({v:+.1f})" for k, v in items[:top] if v < 0]
    return ("It leans towards: " + (", ".join(like) or "nothing clear yet") + ".\n"
            "It leans away from: " + (", ".join(dislike) or "nothing clear yet") + ".\n"
            "Weights are log-odds from your own marks: bigger means a stronger pull. With few labels, rare words can mislead it.")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    need = pipeline_cfg.section("ranker").get("min_labels", 100)
    conn = store.connect()
    lab = labelled(conn)
    good = sum(y for _, y in lab)
    print(f"{len(lab)} labelled rows ({good} good, {len(lab) - good} ignored); {need} needed.")
    if len(lab) < need or good in (0, len(lab)):
        print("Not offered yet: keep marking rows with tools/mark.py." if len(lab) < need else "Needs both good and ignored examples.")
        return 0
    if cmd == "status":
        print("The ranker is available but NOT enabled. Run `ranker.py explain` to see what it learned.")
        return 0
    w = train([(features(j), y) for j, y in lab])
    if cmd == "explain":
        print(explain(w))
    elif cmd == "rank":
        rows = [dict(r) for r in conn.execute("SELECT * FROM jobs WHERE status='new' AND stale=0")]
        for j in sorted(rows, key=lambda j: -score(w, j))[:50]:
            print(f"{score(w, j):.2f}  {j['company']} | {j['title']} | {j['url']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
