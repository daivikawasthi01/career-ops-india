# India job sources: what feeds mine.py

`tools/mine.py` is the single entry point. Each run does feeders (refresh lists), then the steps below.

## Steps and feeders
| Source | How it is read | Where |
|---|---|---|
| Internshala | mine step `internshala` | tools/ |
| Naukri, Indeed, LinkedIn | mine step `jobspy` (`--sites`) | tools/jobspy_scan.py |
| Company career pages (ATS) | mine step `portals` (scan.mjs, `tracked_companies`) | portals.yml |
| Job boards: Unstop, Instahyre, Hirist, OffCampusJobs4u, Freshers Dunia/Hunt/Now, Fresher Openings, Freshers Area, RemoteOK, Remotive, We Work Remotely, Hacker News | `job_boards:` entries with `provider:` | providers/ |
| Search-engine discovery (site: queries) | `search_queries:` | portals.yml |
| Indian ATS tenants (Keka, Zoho Recruit, Darwinbox, Eightfold) | feeders `directory`, `ats-tenants`, `boards`, then `tools/review-india-boards.mjs --apply` | tools/ |
| Telegram channel company names | feeder `telegram` | tools/telegram-companies.mjs |
| Funding news company names | feeder `funding` | tools/funding-companies.mjs |
| Campus programme pages | feeder `campus` (change detection) | tools/watch-campus.mjs |

## Portals directory (21 entries) against our coverage
Direct (scanned every run): LinkedIn, Indeed, Internshala, RemoteOK, We Work Remotely (5).
Through site: search queries only (a lead, not a full scan): Foundit, Wellfound, Angel.co (same as Wellfound), Cutshort, Shine, Freshersworld, Glassdoor (7), plus HyreInsta and JobHai, added this pass (2).
Not covered, outside the India SDE target: ZipRecruiter, SimplyHired, FlexJobs, USAJobs (US residents), Seek (AU/NZ), Europe Language Jobs (6). JobStreet has a provider but only for Indonesia.

## Known gaps
- Wellfound, Cutshort, Foundit, Shine, Freshersworld: no stable public feed; search queries only.
- Instahyre has no posting date; rows sort by id.
- Glassdoor via jobspy is not enabled (unreliable for India); add `glassdoor` to `--sites` to try it.
- Infosys, Wipro, Cognizant, Capgemini programme pages are not in `data/campus-watchlist.txt` (URLs unverified).
- Telegram pings need TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.

## Checks
`node tools/smoke-sources.mjs` runs each provider and feeder on a small input. `node tools/review-india-boards.mjs` re-reviews probe results (safe to repeat).

## Dashboard
`node tools/dashboard/server.mjs` then open http://127.0.0.1:8790 (loopback only; `DASHBOARD_PORT`, `DASHBOARD_PYTHON` and `DASHBOARD_DB` override the defaults).
Tabs: Overview (pipeline ledger, what needs attention), Jobs (jobs.db with status changes), Sources (steps, feeders, job boards, a Run button for each step and feeder), Names (Telegram, funding, directory and campus lists), Boards (reviewed, found, verified and rejected ATS boards), Campus (page changes and failing pages), Runs.
It reads the files the pipeline already writes and starts a step or feeder only from its allowlist; portals.yml is never edited from the page.
Telegram, funding and directory names are also read from data/ by `discover-careers.mjs` (turn off with `--no-data-lists`) and by `probe-india-ats.mjs`, so a feeder run feeds the next discovery run.
