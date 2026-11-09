#!/bin/zsh
# Starts tools/run-careers-overnight.sh after a delay and keeps it alive: logs every step to <data>/careers-supervisor.log.
#   nohup tools/overnight-supervisor.sh 1800 >/dev/null 2>&1 &      # wait 30 min, then run
# A runner that exits non-zero is started again (up to 4 starts, an hour apart). A runner whose status says "running" but has not
# changed for 30 minutes is treated as dead, killed and started again. The runner's own waits ("halted") are left alone.
cd "$(dirname "$0")/.." || exit 1
DATA=${CAREER_OPS_ROOT:-/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops}/data
LOG=$DATA/careers-supervisor.log
DELAY=${1:-0}
stamp() { date '+%Y-%m-%d %H:%M:%S'; }
say() { echo "[$(stamp)] $*" >> "$LOG"; }
say "supervisor started (pid $$), waiting $DELAY s"
sleep $DELAY
starts=0
while [ $starts -lt 4 ]; do
  starts=$((starts + 1))
  say "start $starts: tools/run-careers-overnight.sh"
  tools/run-careers-overnight.sh >> "$DATA/careers-overnight.out" 2>&1 &
  pid=$!
  while kill -0 $pid 2>/dev/null; do
    sleep 60
    for f in "$DATA"/careers-run-pass*.status.json; do
      [ -f "$f" ] || continue
      state=$(sed -n 's/.*"state":"\([a-z]*\)".*/\1/p' "$f")
      age=$(( $(date +%s) - $(stat -f %m "$f") ))
      if [ "$state" = "running" ] && [ $age -gt 1800 ]; then
        say "no progress for $((age / 60)) min in $(basename $f): killing the runner and starting it again"
        pkill -P $pid 2>/dev/null; pkill -f "discover-careers.mjs|careers-pass2.mjs" 2>/dev/null; kill $pid 2>/dev/null
        sleep 5; break
      fi
    done
  done
  wait $pid; code=$?
  say "runner exited with $code"
  [ $code -eq 0 ] && { say "finished"; osascript -e 'display notification "Careers run finished" with title "JobApply"' >/dev/null 2>&1; exit 0; }
  say "waiting 1 hour before starting again"; sleep 3600
done
say "gave up after $starts starts"
exit 1
