#!/bin/zsh
# Run the careers-page phases in this terminal, with a live progress bar for each.
#
#   tools/run-careers.sh                 # phases 1, 2 and the export (pass 3 already runs inside pass 2)
#   tools/run-careers.sh 1               # only pass 1 (find the domain and page for every company)
#   tools/run-careers.sh 2               # only pass 2 (fetch jobs, India check, India versions, other candidates)
#   tools/run-careers.sh 1,2,3,export    # everything, including a separate pass 3 over right-page-no-India companies
#   tools/run-careers.sh 2 --limit 20    # extra arguments go to every phase that accepts them (for a short trial)
#
# Each phase resumes where it stopped, so you can stop with Ctrl-C and run the same command again.
# Logs (also timestamped, kept between runs): <data>/careers-run-pass1.log, -pass2.log, -pass3.log
# Results: <data>/careers-discovery.tsv, careers-pass2.tsv, careers-pass3.tsv, careers-export.csv
# Nothing here edits portals.yml. After the export:  node tools/apply-verified-list.mjs <data>/careers-export.csv   (preview; add --write to apply)
cd "$(dirname "$0")/.." || exit 1
REPO=$PWD
DATA_ROOT=${CAREER_OPS_ROOT:-/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops}
export CAREER_OPS_ROOT=$DATA_ROOT
export CAREER_OPS_ENV_DIR=${CAREER_OPS_ENV_DIR:-$DATA_ROOT}
export CAREER_OPS_PORTALS=${CAREER_OPS_PORTALS:-$DATA_ROOT/portals.yml}
export CAREER_OPS_CHECK_BY_HAND=${CAREER_OPS_CHECK_BY_HAND:-$REPO/data/check-by-hand.txt}
[ -f "$REPO/config/protected-boards.txt" ] && export CAREER_OPS_PROTECTED=${CAREER_OPS_PROTECTED:-$REPO/config/protected-boards.txt}
export CAREER_OPS_UNVALIDATED=1   # the golden check needs your confirmed domains; rows are stamped "unvalidated" until then
COMPANIES=${COMPANIES:-/Users/daivikawasthi/TechnicalProjects/JobApply/companies.txt}

PHASES=${1:-1,2,export}; [ "$#" -gt 0 ] && shift
EXTRA=("$@")
want() { [[ ",$PHASES," == *",$1,"* ]]; }
step() {
  echo; echo "=== $1 ==="; shift
  caffeinate -i "$@"; code=$?
  if [ $code -ne 0 ]; then
    case $code in
      2) msg="search blocked (captcha or rate limit). Run the same command again later to resume." ;;
      3) msg="5 failures in a row. Check the log, then run the same command again to resume." ;;
      4) msg="the LLM failed 5 times in a row (rate limit?). Run again later to resume." ;;
      130) msg="stopped. Run the same command again to resume." ;;
      *) msg="stopped with exit code $code. Run the same command again to resume." ;;
    esac
    echo "STOPPED: $msg"; exit $code
  fi
}

want 1 && step "Phase 1: find each company's domain and careers page" \
  node tools/discover-careers.mjs --llm --all --workers 8 --search-lanes 3 --companies "$COMPANIES" --first "$REPO/data/careers-first.txt" "${EXTRA[@]}"
want 2 && step "Phase 2: fetch jobs, check India, try the India version, keep other candidates" \
  node tools/careers-pass2.mjs --llm --workers 4 "${EXTRA[@]}"
want 3 && step "Phase 3: India version of right-page-no-India portals (standalone rerun)" \
  node tools/careers-pass3.mjs --workers 2 "${EXTRA[@]}"
want export && step "Export: one CSV for portals.yml (scan or watch per company)" \
  node tools/export-careers.mjs
echo; echo "Done. Results are in $DATA_ROOT/data/ (careers-export.csv is the list for portals.yml)."
