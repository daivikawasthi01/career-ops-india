# Scheduling mine.py and careers discovery

Two GitHub Actions workflows in `.github/workflows/` run the pipeline on a schedule. They use a **self-hosted runner**, so
the jobs run on your Mac, with your `data/`, `.env`, `portals.yml`, jobspy venv and home IP. GitHub-hosted runners are not
used: they start empty (no jobs.db, no portals.yml), their data-centre IPs are refused by Naukri, Indeed and LinkedIn, and they
stop a job after 6 hours (careers discovery takes longer).

| Workflow | Triggered by (event type) | Suggested time (IST) | What it runs |
|---|---|---|---|
| `mine-daily.yml` | cron-job.org, `mine-daily` | daily 09:30 | the whole of `mine.py`, every time: all feeders (directory, boards, ATS tenants, board review, Telegram and funding names, campus watch), freehire, Internshala, Naukri and Indeed, portals, the full ATS sweep, the Telegram ping, retention, then the background slow lane for LinkedIn and Glassdoor (8 batches, one an hour) |
| `discovery-weekly.yml` | cron-job.org, `discovery-weekly` | Sunday 02:00 | `tools/overnight-supervisor.sh`: careers discovery for companies not seen yet, resuming where it stopped, then phase 2 and the export |

The workflows have no `schedule:` of their own. The timing lives in cron-job.org, which calls GitHub's `repository_dispatch` API.

There is no per-step schedule inside `mine.py`: nothing is skipped as "not due".

Scheduled runs are real. A manual run (Actions tab, Run workflow) is a dry run unless you untick "Dry run".

## One-time setup

1. **Use your own private repository.** `origin` is `santifer/career-ops`, where you cannot enable Actions. Create a private
   repo on GitHub, then `git remote add mine git@github.com:<you>/<repo>.git && git push mine jobapply-pipeline`.
   `data/`, `.env` and `portals.yml` are gitignored, so none of your data is pushed.
2. **Install the runner on the Mac** (repo, Settings, Actions, Runners, New self-hosted runner, macOS) and run it as a service
   (`./svc.sh install && ./svc.sh start`) so it survives restarts.
3. **Set the folder.** Repo, Settings, Secrets and variables, Actions, Variables: add `CAREER_OPS_DIR` =
   `/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops`.
4. **Try each workflow once** with Run workflow (dry run) and read the log.
5. Keep the Mac awake and online at those hours. A sleeping Mac skips the job; GitHub does not queue it for later.

Telegram and Groq keys stay in `career-ops/.env` on the Mac; nothing goes into GitHub secrets.

## cron-job.org

1. **Token** (fine-grained, limited to this one repo). GitHub, your avatar, Settings, Developer settings, Personal access tokens,
   Fine-grained tokens, Generate new token:
   - Token name: `cron-job-org-career-ops`; Expiration: 1 year (put the date in your calendar, an expired token gives `401`)
   - Resource owner: `daivikawasthi01`; Repository access: **Only select repositories**, then `career-ops-india`
   - Repository permissions: **Actions: Read and write** (Metadata: Read is added automatically). Nothing else.
   - Generate and copy the `github_pat_...` value; GitHub shows it once.
2. **Cron job** (one per workflow), in cron-job.org:
   - URL: `https://api.github.com/repos/daivikawasthi01/career-ops-india/actions/workflows/mine-daily.yml/dispatches`
   - Method: `POST`; Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`, `User-Agent: cron-job.org`
   - Body: `{"ref":"main","inputs":{"dry_run":"false"}}`  (a real run; leave `inputs` out for a dry run)
   - Schedule: daily 09:30, time zone Asia/Kolkata
   - Weekly discovery: same, with `.../workflows/discovery-weekly.yml/dispatches`, body `{"ref":"main"}`, Sunday 02:00
3. A successful call answers `204 No Content`; the run then appears in the repo's Actions tab. `404`: the token cannot see the repo
   or the workflow name is wrong. `401`: wrong or expired token. `422`: the `ref` branch or an input name is wrong.
4. To check the token without starting a run, POST `{"event_type":"ping"}` to
   `https://api.github.com/repos/daivikawasthi01/career-ops-india/dispatches`. No workflow listens to `ping`, so it only answers `204`
   if the token works. (That endpoint needs Contents: Read and write, so with the Actions-only token expect `403`; the real URL above is the test.)
5. Alternative: `repository_dispatch` (`POST .../dispatches`, body `{"event_type":"mine-daily"}`) also starts the workflows, but its
   token needs Contents: Read and write, which can also change code in the repo. The Actions-only token above is safer.
6. The token is the only secret. Keep it in cron-job.org, not in the repo.

## Things to know

- Runs queue per workflow: if yesterday's daily run is still going, today's waits instead of overlapping.
- Never run the old cron watchdog and the weekly workflow together: both start the same supervisor. The watchdog line in your
  crontab is commented out (`#PAUSED`); leave it that way.
- Not verified here: no workflow has run yet, because this checkout has no repository of yours to run them in.

## Plain cron instead (no GitHub)

```
0 9 * * *      cd /Users/daivikawasthi/TechnicalProjects/JobApply/career-ops && tools/.venv-jobspy/bin/python tools/mine.py
0 2 * * 0      cd /Users/daivikawasthi/TechnicalProjects/JobApply/career-ops && tools/overnight-supervisor.sh 0
```
Add `PATH=/opt/homebrew/bin:/usr/bin:/bin` and `CAREER_OPS_ROOT=<the folder>` at the top of the crontab.
