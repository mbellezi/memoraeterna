#!/bin/zsh
# The hourly watchdog of a soak (F3 T64 for the 24 h soak, F4 T89 for the 7-day one; spec 5.4).
#
#   zsh scripts/soak/watch-soak.sh <plan profile> <run directory> <app pid>
#
# Parameterized by the plan profile: the hard stop is the profile's duration plus one hour (169 h for
# `soak7`, 25 h for `soak24`), read from scripts/soak/plan.json. Every hour it writes the run's
# `--status` digest to <run>/status-hourly.log, prints the Soak, FAIL and REVIEW lines, creates the
# STOP file on a FAIL line of a stop check (the driver ends the run within a minute and the app quits),
# and at the hard stop asks for a graceful end, then ends the app. When the app is gone it gives up the
# local-model lock of the data root if the lock still names this run (the app releases it itself on a
# clean end). Runs at background priority: a soak is measured, and so is the Mac it runs on (D2).
#
# Stop checks (spec 5.4; STOP, then D38): calls past deadline; jobs stuck or past twice their
# deadline; any E1 event; swap; P0 wait; the breaker not closed 60 s after a window; helper restarts
# not equal to the kills; remote deadline faults off their bounds; the token budget (the hard cap
# reached, or the projection over the cap past drop step 5); the app gone.
#
# Knobs for a rehearsal: WATCH_INTERVAL_SECONDS (3600), WATCH_GRACE_HOURS (1), WATCH_STOP_WAIT_SECONDS
# (600), WATCH_TERM_WAIT_SECONDS (60), WATCH_REPORT_FLAGS (e.g. --count-local-writer), WATCH_PLAN, and
# WATCH_KILL_PATTERN (the command-line pattern of this checkout's dev server and its app that the hard
# stop ends beside the pid; empty ends the pid only).
set -u
PROFILE=${1:?plan profile (soak7, soak24, ...)}
RUN=${2:?run directory}
PID=${3:?app pid}
HERE=${0:A:h}
ROOT=${HERE:h:h}
PLAN=${WATCH_PLAN:-$HERE/plan.json}
INTERVAL=${WATCH_INTERVAL_SECONDS:-3600}
GRACE_HOURS=${WATCH_GRACE_HOURS:-1}
STOP_WAIT=${WATCH_STOP_WAIT_SECONDS:-600}
TERM_WAIT=${WATCH_TERM_WAIT_SECONDS:-60}
FLAGS=${WATCH_REPORT_FLAGS:-}
START=$(date +%s)
# The dev server and the app of this checkout (its node_modules), never another checkout's.
KILL_PATTERN=${WATCH_KILL_PATTERN-"$ROOT/node_modules.*[Ee]lectron"}

# The hard stop in seconds: the profile's duration plus the grace, from the plan.
LIMIT=$(node -e '
  const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const profile = plan.profiles[process.argv[2]];
  if (!profile) { console.error(`no profile ${process.argv[2]} in the plan`); process.exit(1); }
  console.log(Math.round((profile.durationHours + Number(process.argv[3])) * 3600));
' "$PLAN" "$PROFILE" "$GRACE_HOURS") || { print "watch: the plan has no profile $PROFILE"; exit 1; }

RUNNAME=${RUN:t}
# <data root>/f4/soak/<run>, or <checkout>/.cache/f3/soak/<run>: the lock sits two folders above the family.
LOCK=${RUN:h:h:h}/f2/LOCAL_MODEL_BUSY
print "watch: profile $PROFILE, hard stop after $((LIMIT / 3600)) h $(((LIMIT % 3600) / 60)) min, run $RUNNAME"

release_lock() {
  # Only a lock that still names this run is ours to remove.
  if [[ -f $LOCK ]] && grep -q " run $RUNNAME" $LOCK 2>/dev/null; then
    rm -f $LOCK && print "watch: gave up the local-model lock of $RUNNAME"
  fi
}

cd $ROOT
while kill -0 $PID 2>/dev/null; do
  sleep $INTERVAL
  kill -0 $PID 2>/dev/null || break
  out=$(nice -n 19 npm run -s soak:report -- "$RUN" --status ${=FLAGS} 2>&1)
  { print "==== $(date '+%Y-%m-%d %H:%M:%S')"; print -r -- "$out"; } >> $RUN/status-hourly.log
  print -r -- "$out" | grep -E "^(Soak|FAIL|REVIEW)" | sed "s/^/watch $(date '+%H:%M') /"
  if print -r -- "$out" | grep -qE "^FAIL (Calls past deadline|Jobs|Swap|P0 wait|Breaker|Helper restarts|Remote deadlines|E1 blocked|Tokens)"; then
    touch $RUN/STOP
    print "watch: FAIL on a stop check -> STOP file written"
  fi
  if (( $(date +%s) - START > LIMIT )); then
    # graceful first (the driver stops on STOP and the app quits), then the app, hard
    print "watch: hard stop reached -> STOP, then the app is ended after $STOP_WAIT s"
    touch $RUN/STOP; sleep $STOP_WAIT
    kill -TERM $PID 2>/dev/null
    [[ -n $KILL_PATTERN ]] && pkill -TERM -f "$KILL_PATTERN" 2>/dev/null
    sleep $TERM_WAIT
    [[ -n $KILL_PATTERN ]] && pkill -KILL -f "$KILL_PATTERN" 2>/dev/null
    kill -KILL $PID 2>/dev/null
    break
  fi
done
print "watch: the app is gone at $(date '+%H:%M:%S')"
release_lock
