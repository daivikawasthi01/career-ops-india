#!/bin/zsh
# Run from cron every 30 minutes. Starts tools/overnight-supervisor.sh when it is not running, unless the last run finished.
#   */30 * * * * /Users/daivikawasthi/TechnicalProjects/JobApply/wt-fixes/tools/careers-watchdog.sh
cd "$(dirname "$0")/.." || exit 1
export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin   # claude lives in ~/.local/bin: the last-resort LLM tier needs it
export CAREER_OPS_CLAUDE_FALLBACK=0          # keep the Claude plan free: no claude -p tier
export CAREER_OPS_LLM_MAX_WAIT_MS=240000     # a rate limit is waited out (up to 4 min a time) instead of failing the question
export CAREER_OPS_COMPANY_DEADLINE_MS=900000 # 15 min per company, so those waits fit
DATA=${CAREER_OPS_ROOT:-/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops}/data
LOG=$DATA/careers-supervisor.log
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] watchdog: $*" >> "$LOG"; }
last=$(grep -v "watchdog:" "$LOG" 2>/dev/null | tail -1)
if [[ "$last" == *"] finished" ]]; then exit 0; fi
if pgrep -f "tools/overnight-supervisor.sh" >/dev/null; then exit 0; fi
if pgrep -f "run-careers-overnight.sh|discover-careers.mjs|careers-pass2.mjs" >/dev/null; then say "runner alive without a supervisor, leaving it"; exit 0; fi
say "supervisor not running, starting it"
nohup caffeinate -ims tools/overnight-supervisor.sh 0 >/dev/null 2>&1 &
