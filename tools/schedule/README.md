# Scheduling mine.py (nothing here is installed for you)

`run_mine.sh` is the only thing a scheduler should call. It takes a lock (no overlapping runs), writes a daily log under
`output/logs/`, and returns mine.py's exit code (0 ok, 1 failed or dead source, 3 degraded source).

## macOS (launchd)
See the comment at the top of `com.jobapply.mine.plist`. launchd runs a missed 09:30 start when the Mac wakes.

## cron alternative
`crontab -e`, then add (cron does not catch up after sleep; the next run's window reaches back on its own):

    30 9 * * * /Users/daivikawasthi/TechnicalProjects/JobApply/career-ops/tools/schedule/run_mine.sh

On macOS, cron needs Full Disk Access for /usr/sbin/cron if the repo is under a protected folder.

## After a sleep
mine.py fetches "since each step's last success plus one day" (config `window:`, capped at `max_days`), so a laptop
that slept for three days asks for about four days. `--days N` overrides that.

## Test it by hand first
    tools/schedule/run_mine.sh --dry-run
    tail output/logs/scheduled-$(date +%Y%m%d).log
