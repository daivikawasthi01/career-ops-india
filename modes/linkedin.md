# /career-ops linkedin — LinkedIn search URLs and a manual inbox

**Mode:** discovery
**Extension:** apply-factory
**Complements:** `/career-ops scan` (which covers open ATSs but not LinkedIn)

LinkedIn is searched by hand. Automated browsing of a logged-in LinkedIn session is what gets accounts restricted, so nothing here drives a browser.

## When to invoke

- User: "/career-ops linkedin <query>"
- User: "give me a linkedin search for <role>"

## Procedure

1. Build the search URL:
   ```
   cd extensions/apply-factory && python3 orchestrator.py linkedin-url "<query>" \
     [--date-posted past-24h|past-week|past-month|any] [--experience entry|associate|mid-senior|director|any] \
     [--remote onsite|remote|hybrid|any] [--location "<place>"] [--all]
   ```
   Easy Apply only is the default; `--all` includes the rest. Show the URL and stop. The user browses.

2. When the user picks jobs, stage them:
   ```
   cd extensions/apply-factory && python3 orchestrator.py linkedin-add <url1> <url2> ... [--company X --role Y --jd-file path]
   ```
   Company and role come from the page's public OpenGraph tags when they are readable; otherwise pass them.

3. Staged jobs land in `extensions/apply-factory/data/linkedin-inbox.json` and show up in `/career-ops briefing`. To evaluate one, run `/career-ops <url>`.

## Rules

- Never open LinkedIn with a browser tool from this mode.
- LinkedIn is an aggregator: a staged job is unconfirmed until it is found on the employer's own careers page (AGENTS.md, "Aggregator Listings").
