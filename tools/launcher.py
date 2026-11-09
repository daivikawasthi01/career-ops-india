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
  python3 tools/launcher.py --batch 10 --pause 2  # open 10 tabs, wait for Enter, repeat
"""

import argparse
import sys
import time
import webbrowser
from urllib.parse import quote_plus, urlencode

# Same searches the scanners use (scan-jobspy.mjs TERMS).
TERMS = [
    "software engineer fresher", "software developer fresher", "sde 1", "associate software engineer",
    "graduate engineer trainee", "backend developer fresher", "full stack developer fresher",
    "python developer fresher", "java developer fresher", "data engineer fresher",
    "machine learning engineer fresher", "software engineer intern",
    "frontend developer fresher", "web developer fresher", "devops engineer fresher", "cloud engineer fresher",
    "junior software engineer", "software engineer trainee", "sde intern", "ai engineer fresher",
]

LOCATION = "India"


def _window(days):
    """Smallest window the sites offer that covers `days`: (google qdr, linkedin posts, google jobs chip)."""
    if days <= 1:
        return "d", "past-24h", "today"
    if days <= 7:
        return "w", "past-week", "week" if days > 3 else "3days"
    return "m", "past-month", "month"


def google(term, days):
    # Web search for hiring posts and career pages: past window, sorted by date (newest first).
    qdr, _, _ = _window(days)
    q = urlencode({"q": f"hiring {term} India", "tbs": f"qdr:{qdr},sbd:1", "hl": "en", "gl": "in"})
    return f"https://www.google.com/search?{q}"


def google_jobs(term, days):
    # Google Jobs panel, posted within the window. The panel has a "Date posted" sort toggle but no URL parameter for it.
    _, _, chip = _window(days)
    q = urlencode({"q": f"{term} jobs in {LOCATION}", "ibp": "htl;jobs", "htichips": f"date_posted:{chip}", "hl": "en", "gl": "in"})
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
    q = urlencode({"q": term, "l": LOCATION, "fromage": days, "sort": "date"})
    return f"https://in.indeed.com/jobs?{q}"


def naukri(term, days):
    slug = term.strip().lower().replace(" ", "-")
    return f"https://www.naukri.com/{slug}-jobs?jobAge={days}&experience=0"


def internshala(term, days):
    return f"https://internshala.com/jobs/keywords-{quote_plus(term).replace('+', '-')}/"


def foundit(term, days):
    q = urlencode({"query": term, "locations": LOCATION, "experienceRanges": "0~0", "jobFreshness": days})
    return f"https://www.foundit.in/srp/results?{q}"


def wellfound(term, days):
    return f"https://wellfound.com/role/l/{term.strip().lower().replace(' ', '-')}/india"


SITES = {
    "google": google, "google-jobs": google_jobs, "linkedin": linkedin, "linkedin-jobs": linkedin_jobs, "indeed": indeed, "naukri": naukri,
    "internshala": internshala, "foundit": foundit, "wellfound": wellfound,
}
DEFAULT_SITES = "google,google-jobs,linkedin"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=1, help="posted within this many days")
    ap.add_argument("--sites", default=DEFAULT_SITES, help=f"comma list of: {', '.join(SITES)}")
    ap.add_argument("--all", action="store_true", help="use every site")
    ap.add_argument("--terms", help="comma list of search terms (default: the scanner terms)")
    ap.add_argument("--batch", type=int, default=0, help="open this many tabs, then wait for Enter (0 = all at once)")
    ap.add_argument("--pause", type=float, default=0.4, help="seconds between tabs, so the browser keeps up")
    ap.add_argument("--dry-run", action="store_true", help="print URLs, open nothing")
    args = ap.parse_args()

    names = list(SITES) if args.all else [s.strip() for s in args.sites.split(",") if s.strip()]
    unknown = [n for n in names if n not in SITES]
    if unknown:
        sys.exit(f"unknown site(s): {', '.join(unknown)}. choose from: {', '.join(SITES)}")
    terms = [t.strip() for t in args.terms.split(",") if t.strip()] if args.terms else TERMS

    # Group by site so each site's tabs sit together.
    urls = [(n, t, SITES[n](t, args.days)) for n in names for t in terms]
    print(f"{len(urls)} tab(s): {len(names)} site(s) x {len(terms)} term(s), last {args.days} day(s)")

    for i, (site, term, url) in enumerate(urls, 1):
        if args.dry_run:
            print(f"{site:<12} {term:<34} {url}")
            continue
        webbrowser.open_new_tab(url)
        print(f"[{i}/{len(urls)}] {site}: {term}")
        time.sleep(args.pause)
        if args.batch and i % args.batch == 0 and i < len(urls):
            input(f"-- {i} opened. Press Enter for the next {min(args.batch, len(urls) - i)} --")


if __name__ == "__main__":
    main()
