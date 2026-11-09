#!/bin/bash
# Scheduled wrapper for tools/mine.py: one run at a time, logs kept, safe after the laptop slept.
#
#   * Lock: mkdir is atomic, so two runs can never overlap. A lock whose pid is gone is cleared.
#   * Sleep: the scan window is "since the last success + 1 day" (config window:), so a run after
#     a long sleep automatically reaches back far enough; launchd also runs a missed start on wake.
#   * Logs: output/logs/scheduled-YYYYMMDD.log, last 30 kept.
#
# Not installed by anything. See tools/schedule/README.md.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$ROOT/tools/.venv-jobspy/bin/python"
LOCK="$ROOT/data/cache/mine.lock"
LOGDIR="$ROOT/output/logs"
LOG="$LOGDIR/scheduled-$(date +%Y%m%d).log"
mkdir -p "$LOGDIR" "$ROOT/data/cache"

if ! mkdir "$LOCK" 2>/dev/null; then
  OLD="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "$(date '+%F %T') another run is active (pid $OLD); skipping" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') clearing stale lock (pid ${OLD:-none})" >> "$LOG"
  rm -rf "$LOCK"
  mkdir "$LOCK" || exit 1
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT INT TERM

cd "$ROOT" || exit 1
echo "$(date '+%F %T') start: $PY tools/mine.py $*" >> "$LOG"
"$PY" tools/mine.py "$@" >> "$LOG" 2>&1
CODE=$?
echo "$(date '+%F %T') end, exit $CODE (0 ok, 1 failed or dead source, 3 degraded source)" >> "$LOG"
ls -1t "$LOGDIR"/scheduled-*.log 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null
exit $CODE
