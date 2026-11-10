#!/bin/zsh
# Unattended run of phases 1 and 2 plus the export. Start it in a terminal and leave it:
#
#   cd /Users/daivikawasthi/TechnicalProjects/JobApply/career-ops
#   tools/run-careers-overnight.sh                  # everything, retries when a phase halts
#   tools/run-careers-overnight.sh 2                # only phase 2 (for example after phase 1 is done)
#
# Differences from tools/run-careers.sh:
#   - never opens a captcha window (--no-headed): a search block only slows the run down;
#   - when a phase halts (search blocked, companies failing to load) it waits 45 minutes and resumes it, up to 8 times per phase;
#     when the Groq daily limit stops it, it sleeps until the reset time the API reported (retry-after), at most 8 hours, then resumes;
#   - keeps the Mac awake (display may still sleep) and sends a notification at the end.
# Keep the laptop plugged in and the lid open (a closed lid sleeps the Mac whatever caffeinate says), or use an external display.
# Watch it from the dashboard (run panel at the top) or: tail -f <data>/careers-run-pass1.log
# Environment: WAIT_SECS (default 2700) and MAX_RETRIES (default 8) can be changed.
cd "$(dirname "$0")/.." || exit 1
REPO=$PWD
DATA_ROOT=${CAREER_OPS_ROOT:-/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops}
export CAREER_OPS_ROOT=$DATA_ROOT
export CAREER_OPS_ENV_DIR=${CAREER_OPS_ENV_DIR:-$DATA_ROOT}
export CAREER_OPS_PORTALS=${CAREER_OPS_PORTALS:-$DATA_ROOT/portals.yml}
export CAREER_OPS_CHECK_BY_HAND=${CAREER_OPS_CHECK_BY_HAND:-$REPO/data/check-by-hand.txt}
[ -f "$REPO/config/protected-boards.txt" ] && export CAREER_OPS_PROTECTED=${CAREER_OPS_PROTECTED:-$REPO/config/protected-boards.txt}
export CAREER_OPS_UNVALIDATED=1 CAREER_OPS_NO_HEADED=1
export CAREER_OPS_CLAUDE_FALLBACK=${CAREER_OPS_CLAUDE_FALLBACK:-1}   # last-resort tier: claude -p on your plan when Groq and Gemini are out. Set to 0 to turn off.
COMPANIES=${COMPANIES:-/Users/daivikawasthi/TechnicalProjects/JobApply/companies.txt}
WAIT_SECS=${WAIT_SECS:-2700}
RESUME_FILE=$DATA_ROOT/data/careers-llm-resume.txt
MAX_RETRIES=${MAX_RETRIES:-8}
PHASES=${1:-1,2,export}
want() { [[ ",$PHASES," == *",$1,"* ]]; }
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Run one phase; on a halt (exit 2 search blocked, 3 failures, 4 LLM) wait and resume it. Any other exit code ends it.
run_phase() {
  local name=$1; shift
  local tries=0 code
  while true; do
    echo; echo "[$(stamp)] $name: start (attempt $((tries + 1)))"
    caffeinate -ims "$@"; code=$?
    case $code in
      0) echo "[$(stamp)] $name: finished"; return 0 ;;
      2|3|4)
        tries=$((tries + 1))
        if [ $tries -gt $MAX_RETRIES ]; then echo "[$(stamp)] $name: still halting after $MAX_RETRIES waits (exit $code). Giving up on this phase."; return $code; fi
        wait=$WAIT_SECS
        # Exit 4 with a reset time from the Groq daily limit (its retry-after header): sleep until then, at most 8 hours.
        if [ $code -eq 4 ] && [ -f "$RESUME_FILE" ]; then
          reset=$(cat "$RESUME_FILE" 2>/dev/null); rm -f "$RESUME_FILE"
          if [[ "$reset" == <-> ]]; then wait=$(( reset - $(date +%s) + 60 )); [ $wait -gt 28800 ] && wait=28800; [ $wait -lt 60 ] && wait=60; fi
        fi
        echo "[$(stamp)] $name: halted (exit $code). Waiting $((wait / 60)) min, then resuming ($tries of $MAX_RETRIES)."
        sleep $wait ;;
      *) echo "[$(stamp)] $name: stopped with exit code $code."; return $code ;;
    esac
  done
}

final=0
if want 1; then
  run_phase "phase 1" node tools/discover-careers.mjs --llm --all --workers 6 --search-lanes 2 --no-headed --companies "$COMPANIES" --first "$REPO/data/careers-first.txt"; r=$?
  [ $r -ne 0 ] && { echo "Phase 1 did not finish, so phase 2 would work from a partial list. Stopping."; final=$r; }
fi
if [ $final -eq 0 ] && want 2; then
  run_phase "phase 2" node tools/careers-pass2.mjs --llm --workers 4 --no-headed; r=$?; [ $r -ne 0 ] && final=$r
fi
if want export; then
  node tools/export-careers.mjs
fi
msg="Careers run finished (exit $final). Open the dashboard, then node tools/apply-verified-list.mjs data/careers-export.csv to preview."
[ $final -ne 0 ] && msg="Careers run stopped (exit $final). See data/careers-run-pass*.log. Run the same command again to resume."
echo; echo "[$(stamp)] $msg"
osascript -e "display notification \"$msg\" with title \"JobApply\" sound name \"Glass\"" >/dev/null 2>&1
exit $final
