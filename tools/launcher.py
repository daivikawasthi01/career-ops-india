#!/usr/bin/env python3
"""Open job-search tabs in your browser for manual checking and applying.

One command opens a tab per (site, search term) with the fresher filters already
applied: India, posted in the last N days, entry level. Nothing is scraped or
automated. It only builds search URLs and hands them to your default browser,
so you browse and apply yourself.

  python3 tools/launcher.py                       # Google (posts), Google Jobs, LinkedIn posts, last 24h, newest first
  python3 tools/launcher.py --days 7
  python3 tools/launcher.py --sites google,linkedin,linkedin-jobs,indeed,naukri
  python3 tools/launcher.py --all                 # every site below
  python3 tools/launcher.py --terms "sde 1,devops engineer fresher"
  python3 tools/launcher.py --dry-run             # print the URLs, open nothing
  python3 tools/launcher.py --batch 10 --pause 2  # open 10 tabs, wait for Enter, repeat (default 10, config launcher:)
  python3 tools/launcher.py --dry-run --samples 5 # print 5 URLs per site to click-check the filters
  python3 tools/launcher.py --profile weekly      # open the links in tools/weekly_links.txt instead of searches
  python3 tools/launcher.py --dry-run --csv checklist.csv   # label,url,done for a spreadsheet

Google may show a captcha; solve it by hand. The tool never reduces terms or search types because of that.
"""

import argparse
import csv
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import quote_plus, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pipeline_cfg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def terms_from_config():
    """The same 20 terms the scanners use: config/pipeline.yml jobspy.terms."""
    return list(pipeline_cfg.section("jobspy").get("terms") or [])


def snap_up(days, allowed):
    """Smallest value a site offers that still covers `days`."""
    return next((a for a in allowed if a >= days), allowed[-1])

LOCATION = "India"


def _window(days):
    """Smallest window the sites offer that covers `days`: (google qdr, linkedin posts, google jobs chip)."""
    if days <= 1:
        return "d", "past-24h", "today"
    if days <= 7:
        return ("d%d" % days if days < 7 else "w"), "past-week", "week" if days > 3 else "3days"
    return "m", "past-month", "month"


def google(term, days):
    # Web search for hiring posts and career pages: past window, newest first (tbs=qdr:<window>,sbd:1).
    qdr, _, _ = _window(days)
    q = urlencode({"q": f"hiring {term} India", "tbs": f"qdr:{qdr},sbd:1", "hl": "en", "gl": "in"})
    return f"https://www.google.com/search?{q}"


def google_jobs(term, days):
    # Google Jobs: udm=8 is the Jobs tab; the date chip needs BOTH htichips and htischips to stick.
    # The panel has a "Date posted" sort toggle but no URL parameter for it.
    _, _, chip = _window(days)
    q = urlencode({"q": f"{term} jobs in {LOCATION}", "udm": "8", "ibp": "htl;jobs", "htichips": f"date_posted:{chip}",
                   "htischips": f"date_posted;{chip}", "hl": "en", "gl": "in"})
    return f"https://www.google.com/search?{q}"


def linkedin(term, days):
    # LinkedIn POSTS (content search), latest first. LinkedIn only offers past-24h, past-week, past-month.
    _, window, _ = _window(days)
    q = urlencode({"keywords": f"hiring {term}", "origin": "FACETED_SEARCH",
                   "datePosted": f'"{window}"', "sortBy": '"date_posted"'})
    return f"https://www.linkedin.com/search/results/content/?{q}"


def linkedin_jobs(term, days):
    # f_TPR seconds since posting, f_E experience (1 internship, 2 entry level), sortBy=DD most recent.
    q = urlencode({"keywords": term, "location": LOCATION, "f_TPR": f"r{days * 86400}", "f_E": "1,2", "sortBy": "DD"})
    return f"https://www.linkedin.com/jobs/search/?{q}"


def indeed(term, days):
    # fromage accepts 1, 3, 7 or 14 days.
    q = urlencode({"q": term, "l": LOCATION, "fromage": snap_up(days, [1, 3, 7, 14]), "sort": "date"})
    return f"https://in.indeed.com/jobs?{q}"


def naukri(term, days):
    # jobAge accepts 1, 3, 7, 15 or 30 days; experience=0 is freshers.
    slug = term.strip().lower().replace(" ", "-")
    q = urlencode({"k": term, "experience": 0, "jobAge": snap_up(days, [1, 3, 7, 15, 30])})
    return f"https://www.naukri.com/{slug}-jobs?{q}"


def internshala(term, days):
    return f"https://internshala.com/jobs/keywords-{quote_plus(term).replace('+', '-')}/"


def foundit(term, days):
    q = urlencode({"query": term, "locations": LOCATION, "experienceRanges": "0~0", "jobFreshness": snap_up(days, [1, 3, 7, 15, 30])})
    return f"https://www.foundit.in/srp/results?{q}"


def wellfound(term, days):
    return f"https://wellfound.com/role/l/{term.strip().lower().replace(' ', '-')}/india"


def unstop(term, days):
    # Unstop job search by keyword, open postings only. Check the freshness sort on the page (no URL parameter known).
    q = urlencode({"searchTerm": term, "oppstatus": "open"})
    return f"https://unstop.com/job-search?{q}"


SITES = {
    "google": google, "google-jobs": google_jobs, "linkedin": linkedin, "linkedin-jobs": linkedin_jobs, "indeed": indeed, "naukri": naukri,
    "internshala": internshala, "foundit": foundit, "wellfound": wellfound, "unstop": unstop,
}

# What each site's URL is supposed to apply, so a dry run can say what to look for when you click a sample.
EXPECT = {
    "google": "Tools > 'Past 24 hours' (or past N days) selected, sorted by date",
    "google-jobs": "Jobs tab with the 'Date posted' chip set to Today / 3 days / week",
    "linkedin": "Posts tab, 'Date posted: Past 24 hours', 'Sort by: Latest'",
    "linkedin-jobs": "'Past 24 hours', Internship + Entry level ticked, 'Most recent'",
    "indeed": "'Date posted' set (last 1/3/7/14 days), sorted by date",
    "naukri": "Freshness filter set, experience 0 / fresher",
    "internshala": "keyword page only; no date parameter exists",
    "foundit": "Freshness and fresher experience filters set",
    "wellfound": "role page for India; no date parameter exists",
    "unstop": "keyword results, open only; freshness not settable in the URL",
}

DEFAULT_SITES = "google,google-jobs,linkedin"


def parse_weekly(text):
    """Lines of tools/weekly_links.txt: `url` or `label | url`; blank lines and #comments are skipped."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        label, sep, url = line.rpartition("|")
        url = url.strip()
        if url.startswith("http"):
            out.append(("weekly", label.strip() if sep and label.strip() else url, url))
    return out


def build_plan(names, terms, days):
    """(site, label, url) for every site and term, grouped by site."""
    return [(n, t, SITES[n](t, days)) for n in names for t in terms]


def sample(plan, per_site):
    seen, out = {}, []
    for item in plan:
        if seen.get(item[0], 0) < per_site:
            seen[item[0]] = seen.get(item[0], 0) + 1
            out.append(item)
    return out


def write_csv(path, plan):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["label", "url", "done"])
        for site, label, url in plan:
            w.writerow([f"{site}: {label}" if site != "weekly" else label, url, ""])


def main():
    cfg = pipeline_cfg.section("launcher")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=1, help="posted within this many days")
    ap.add_argument("--sites", default=DEFAULT_SITES, help=f"comma list of: {', '.join(SITES)}")
    ap.add_argument("--all", action="store_true", help="use every site")
    ap.add_argument("--terms", help="comma list of search terms (default: the scanner terms)")
    ap.add_argument("--profile", choices=["weekly"], help="weekly: open the links in tools/weekly_links.txt instead of searches")
    ap.add_argument("--batch", type=int, default=cfg.get("batch", 10), help="open this many tabs, then wait for Enter (0 = all at once)")
    ap.add_argument("--pause", type=float, default=cfg.get("pause_seconds", 0.4), help="seconds between tabs, so the browser keeps up")
    ap.add_argument("--dry-run", action="store_true", help="print URLs, open nothing")
    ap.add_argument("--samples", type=int, default=0, help="with --dry-run: print only this many URLs per site, plus what to check")
    ap.add_argument("--csv", help="write a label,url,done checklist to this path")
    args = ap.parse_args()

    if args.profile == "weekly":
        path = ROOT / cfg.get("weekly_links", "tools/weekly_links.txt")
        if not path.exists():
            sys.exit(f"{path} not found")
        plan = parse_weekly(path.read_text(encoding="utf-8"))
        if not plan:
            sys.exit(f"{path} has no links yet. Add one URL per line (label | url) and run again.")
        print(f"{len(plan)} weekly link(s) from {path.name}")
    else:
        names = list(SITES) if args.all else [s.strip() for s in args.sites.split(",") if s.strip()]
        unknown = [n for n in names if n not in SITES]
        if unknown:
            sys.exit(f"unknown site(s): {', '.join(unknown)}. choose from: {', '.join(SITES)}")
        terms = [t.strip() for t in args.terms.split(",") if t.strip()] if args.terms else terms_from_config()
        plan = build_plan(names, terms, args.days)
        print(f"{len(plan)} tab(s): {len(names)} site(s) x {len(terms)} term(s), last {args.days} day(s)")

    if args.csv:
        write_csv(args.csv, plan)
        print(f"checklist written: {args.csv}")
    if args.dry_run and args.samples:
        shown = sample(plan, args.samples)
        for site in dict.fromkeys(s for s, _, _ in shown):
            print(f"\n[{site}] check: {EXPECT.get(site, 'see the site')}")
            for _, term, url in (x for x in shown if x[0] == site):
                print(f"  {term:<34} {url}")
        return
    for i, (site, term, url) in enumerate(plan, 1):
        if args.dry_run:
            print(f"{site:<12} {term:<34} {url}")
            continue
        webbrowser.open_new_tab(url)
        print(f"[{i}/{len(plan)}] {site}: {term}")
        time.sleep(args.pause)
        if args.batch and i % args.batch == 0 and i < len(plan):
            input(f"-- {i} opened. Press Enter for the next {min(args.batch, len(plan) - i)} --")


if __name__ == "__main__":
    main()
