#!/bin/zsh
# Run tools/discover-careers.mjs detached from the terminal, kept awake, logged, with a macOS notification at the end.
#
#   nohup caffeinate -i tools/run-discover.sh --llm > /dev/null 2>&1 &      # start; safe to close the terminal
#   tail -f data/discover.log                                         # watch it
#   cat data/careers-discovery.status.json                            # done/total, seconds per company
#   pkill -f discover-careers.mjs                                     # stop; rerunning resumes where it stopped
#
# Extra arguments go to the script:  tools/run-discover.sh --limit 10
cd "$(dirname "$0")/.." || exit 1
LOG=data/discover.log
mkdir -p data
echo "=== $(date '+%Y-%m-%d %H:%M:%S') start $* ===" >> "$LOG"
caffeinate -i node tools/discover-careers.mjs "$@" >> "$LOG" 2>&1
code=$?
echo "=== $(date '+%Y-%m-%d %H:%M:%S') exit $code ===" >> "$LOG"
case $code in
  0) msg="Careers discovery finished" ;;
  2) msg="Careers discovery HALTED: captcha or rate limit. Rerun later to resume." ;;
  3) msg="Careers discovery HALTED: 5 failures in a row. Check data/discover.log." ;;
  4) msg="Careers discovery HALTED: the LLM failed 5 times in a row (rate limit?). Rerun later to resume." ;;
  5) msg="Careers discovery did not start or the golden check failed. See data/discover.log." ;;
  *) msg="Careers discovery stopped with exit code $code. See data/discover.log." ;;
esac
osascript -e "display notification \"$msg\" with title \"JobApply\" sound name \"Glass\"" >/dev/null 2>&1
exit $code
