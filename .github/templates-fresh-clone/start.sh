#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: start-template.sh <directory> <command> <ready pattern>" >&2
  exit 2
fi

directory=$1
command=$2
ready=$3
failed='(^|\| )✖ |Failed to (start|construct) modules'
deadline=$((SECONDS + ${START_TIMEOUT_SECONDS:-600}))
settle=${SETTLE_SECONDS:-10}
log=$(mktemp)

cd "$directory"
setsid bash -c "$command" > "$log" 2>&1 &
group=$!

stop() {
  kill -TERM -- "-$group" 2> /dev/null || true
  for _ in $(seq 50); do
    kill -0 -- "-$group" 2> /dev/null || return 0
    sleep 0.2
  done
  kill -KILL -- "-$group" 2> /dev/null || true
}

fail() {
  stop
  echo "::group::Output of ${command}"
  cat "$log"
  echo "::endgroup::"
  echo "::error::${1}"
  exit 1
}

until grep -qE -- "$ready" "$log"; do
  kill -0 "$group" 2> /dev/null || fail "${command} exited before printing /${ready}/."
  grep -qE -- "$failed" "$log" && fail "${command} printed /${failed}/ before /${ready}/."
  [ "$SECONDS" -lt "$deadline" ] || fail "${command} did not print /${ready}/ within ${START_TIMEOUT_SECONDS:-600} s."
  sleep 1
done

sleep "$settle"
kill -0 "$group" 2> /dev/null || fail "${command} exited within ${settle} s of printing /${ready}/."
grep -qE -- "$failed" "$log" && fail "${command} printed /${failed}/."
stop
