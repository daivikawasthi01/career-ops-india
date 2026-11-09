"""Merge offers from every source into one row per job.

Two offers are the same job when they share the canonical URL OR the fuzzy key
(company + title + city). Matching is transitive: A=B by URL and B=C by fuzzy key gives one row.
"""
from collections import Counter
from datetime import date
from itertools import combinations

from canonical import canonical_url, company_key, config, fuzzy_key, host_matches, host_of, title_tokens

KNOWN_SITES = ("linkedin", "naukri", "indeed", "internshala", "wellfound", "instahyre", "shine", "unstop", "cutshort")


def source_label(offer, step=""):
    """A short platform name for found_by: the site for aggregators, the ATS name for employer boards."""
    host = host_of(offer.get("url"))
    for key in KNOWN_SITES:
        if key in host:
            return key
    for d in config()["employer_hosts"]:
        if host_matches(host, [d]):
            return d.split(".")[0]
    return str(offer.get("source") or step or "unknown").split(":")[-1].lower()


def url_rank(url):
    """0 employer ATS, 1 anything else, 2 aggregator. Lower is better."""
    host = host_of(url)
    cfg = config()
    if host_matches(host, cfg["employer_hosts"]):
        return 0
    if host_matches(host, cfg["aggregator_hosts"]):
        return 2
    return 1


class _Sets:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def merge_offers(per_step, today=None):
    """per_step: {step_id: [offer dict]}. Returns merged rows, best-first fields plus:
    found_by (sorted platform names), first_seen {platform: date}, steps (set), urls (all canonical URLs),
    confidence ('employer-confirmed' when the best link is an employer ATS, else 'aggregator')."""
    today = today or date.today().isoformat()
    flat = [(step, o) for step, offers in per_step.items() for o in offers if o.get("url")]
    sets = _Sets(len(flat))
    seen = {}
    for i, (_, o) in enumerate(flat):
        for key in (("u", canonical_url(o["url"])), ("f", fuzzy_key(o.get("company"), o.get("title"), o.get("location")))):
            if key[1] is None:
                continue
            if key in seen:
                sets.union(i, seen[key])
            else:
                seen[key] = i
    groups = {}
    for i in range(len(flat)):
        groups.setdefault(sets.find(i), []).append(flat[i])

    merged = []
    for members in groups.values():
        members.sort(key=lambda m: (url_rank(m[1]["url"]), -len(m[1].get("title") or "")))
        best = members[0][1]
        row = {**best, "url": best["url"], "canonical_url": canonical_url(best["url"])}
        first_seen = {}
        for step, o in members:
            label = source_label(o, step)
            seen_on = o.get("first_seen") or today
            first_seen[label] = min(first_seen.get(label, seen_on), seen_on)
            for field in ("company", "title", "location", "posted"):
                if not row.get(field) and o.get(field):
                    row[field] = o[field]
        row["found_by"] = sorted(first_seen)
        row["first_seen"] = first_seen
        row["steps"] = {step for step, _ in members}
        row["urls"] = sorted({canonical_url(o["url"]) for _, o in members})
        row["confidence"] = "employer-confirmed" if url_rank(row["url"]) == 0 else "aggregator"
        merged.append(row)
    return merged


def collapse_stats(merged):
    """How many duplicates collapsed per pair of platforms: {('linkedin','naukri'): 3}."""
    pairs = Counter()
    for row in merged:
        for a, b in combinations(row["found_by"], 2):
            pairs[(a, b)] += 1
    return dict(pairs)


def similar_unmerged(merged, overlap=None):
    """Pairs of different merged rows at the same company that look alike but did not merge."""
    overlap = overlap if overlap is not None else config()["similar_title_overlap"]
    by_company = {}
    for row in merged:
        c = company_key(row.get("company"))
        if c:
            by_company.setdefault(c, []).append(row)
    out = []
    for rows in by_company.values():
        for a, b in combinations(rows, 2):
            ta, tb = set(title_tokens(a.get("title"))), set(title_tokens(b.get("title")))
            if ta and tb and len(ta & tb) / len(ta | tb) >= overlap:
                out.append((a, b))
    return out
