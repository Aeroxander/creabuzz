#!/usr/bin/env bash
#
# scripts/test-pilot-commands.sh — the owner's pilot commands in deploy/compose/run.sh (`founders`, `due`, `daily`) read the
# right records and say so.
#
# It makes a scratch database from the repository's own schema (schema/schema.sql), fills it with a pilot's worth of update
# records (founders on time and late, a deleted update, a promise answered twice, offers, tasks, the operator's own project),
# and runs the REAL run.sh and pilot/*.sql against it. Only `docker` is a stand-in: it hands the SQL that run.sh pipes into
# the postgres container to the real psql, and answers `buzz-admin reports`. No relay, chain or browser needed; it needs
# Postgres (the same one `just services` and the MVP gate's CI job start). The same queries were also run against the
# records the real server journey writes (scripts/real-loop-e2e.sh, KEEP_DB=1): see docs/v3-review/PILOT-REPORT.md.
#
# ⚠️  DEV ONLY. Uses its own database, dropped on exit.
# Usage:  scripts/test-pilot-commands.sh
# Env:    POSTGRES_ADMIN_URL (default postgres://buzz:buzz_dev@127.0.0.1:5432/postgres)

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
DB="buzz_pilot_cmds_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
WORK="$(mktemp -d)"
failures=0
DB_MADE=""
cleanup() {
  [[ -n "$DB_MADE" ]] && psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

check() { # check "what" <0 when it held>
  if [[ $2 -eq 0 ]]; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi
}
yes_if() { if "$@"; then echo 0; else echo 1; fi; }
has() { grep -qF -- "$2" <<<"$1"; }
lacks() { ! grep -qF -- "$2" <<<"$1"; }

command -v psql >/dev/null 2>&1 || { echo "skip: psql is not installed"; exit 0; }
if ! psql "$ADMIN_URL" -qAtc 'select 1' >/dev/null 2>&1; then
  echo "skip: Postgres is not answering at $ADMIN_URL (start it with \`just services\`)"
  exit 0
fi
psql "$ADMIN_URL" -qc "create database $DB" || { echo "could not create the scratch database"; exit 1; }
DB_MADE=1
(cd "$REPO_ROOT/schema" && psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f schema.sql >/dev/null 2>"$WORK/schema.err") \
  || { cat "$WORK/schema.err"; echo "could not load schema/schema.sql"; exit 1; }

# ── The server folder: the real run.sh, its helpers and the pilot queries, with a stand-in docker ──────────────────────
COMPOSE_DIR="$WORK/deploy/compose"
mkdir -p "$COMPOSE_DIR/pilot" "$WORK/bin"
cp "$REPO_ROOT/deploy/compose/run.sh" "$REPO_ROOT/deploy/compose/compose-env.sh" "$COMPOSE_DIR/"
cp "$REPO_ROOT"/deploy/compose/pilot/*.sql "$COMPOSE_DIR/pilot/"
cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# `docker compose ... exec -T postgres sh -c '<script>' psql <args>`: run the real psql on the scratch database with <args>.
# `docker compose ... exec -T relay /usr/local/bin/buzz-admin reports ...`: the reports the test gave it.
args=("$@")
for i in "${!args[@]}"; do
  if [[ "${args[$i]}" == "-c" && "${args[$((i + 2))]:-}" == "psql" ]]; then
    exec psql "$TEST_DB_URL" "${args[@]:$((i + 3))}"
  fi
done
if [[ " $* " == *"/buzz-admin reports "* ]]; then
  [[ "${FAKE_REPORTS_STATUS:-0}" == "0" ]] || { echo "buzz-admin: the relay is not running" >&2; exit "$FAKE_REPORTS_STATUS"; }
  echo "${FAKE_REPORTS:-no escalated reports}"
  exit 0
fi
echo "stand-in docker: unexpected call: $*" >&2
exit 99
STUB
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH" TEST_DB_URL="$DB_URL"

# ── The records ───────────────────────────────────────────────────────────────────────────────────────────────────────
ASOF=1795000000 # a fixed clock, so "days ago" never drifts
export BUZZ_PILOT_AS_OF="$ASOF"
hex() { printf '%064x' "$1"; }
# A key that starts with a few letters of its owner's name, so a founder with no profile shows as those eight characters.
key() { printf '%s%0*d' "$1" $((64 - ${#1})) 0; }
ALICE=$(key a11ce) BOB=$(key b0b) CARA=$(key ca4a) DAN=$(key da4) EVE=$(key e4e) OPERATOR=$(key 0be4a) FAY=$(key fa4)
HELPER=$(key 4e19e4) MATE=$(key 3a7e)
SQL="$WORK/fixture.sql"
echo "insert into communities (host) values ('pilot.test');" >"$SQL"
N=0
# The id the next ev will give its record (a record can then name itself).
next_id() { hex $((0x1000000 + N + 1)); }
# ev <days ago> <author> <kind> <tags json> [deleted] [d tag] [content] -> the new record's id is in $LAST (not printed: a subshell would lose the counter)
ev() {
  local days="$1" author="$2" kind="$3" tags="$4" deleted="${5:-}" dtag="${6:-}" content="${7:-}" id d=null del=null
  N=$((N + 1))
  id="$(hex $((0x1000000 + N)))"
  [[ -n "$dtag" ]] && d="'$dtag'"
  [[ -n "$deleted" ]] && del="to_timestamp($ASOF)"
  printf "insert into events (community_id, id, pubkey, created_at, kind, tags, content, sig, d_tag, deleted_at) values
    ((select id from communities limit 1), decode('%s','hex'), decode('%s','hex'), to_timestamp(%s), %s, '%s'::jsonb, '%s', decode(repeat('00',64),'hex'), %s, %s);\n" \
    "$id" "$author" "$((ASOF - days * 86400))" "$kind" "$tags" "$content" "$d" "$del" >>"$SQL"
  LAST="$id"
}
# project <founder> <days ago> <slug> <name> [more tags]: the founder's project record
project() { ev "$2" "$1" 37001 "[[\"d\",\"$3\"],[\"name\",\"$4\"]${5:+,$5}]" "" "$3"; }
# The slug a project's records name, as the web app writes it.
coord() { echo "37001:$1:$2"; }

# Alice: three weekly updates, the third after a late flag, promises answered, one answered twice (the worse counts), a
# deleted update that would make her current, help asked and offered, three tasks.
A="$(coord "$ALICE" nebula)"
project "$ALICE" 30 nebula Nebula "[\"team\",\"$MATE\",\"member\"]" >/dev/null
ev 30 "$ALICE" 0 '[]' "" "" '{"name":"Alice"}' >/dev/null
ev 30 "$HELPER" 0 '[]' "" "" 'not json' >/dev/null # a profile that is not readable: no name, no failure
ev 29 "$ALICE" 47003 "[[\"a\",\"$A\"],[\"goal\",\"main\"],[\"goal-level\",\"primary\"],[\"goal-text\",\"Ten users\"],[\"goal-state\",\"open\"]]" >/dev/null
U1="$(next_id)"
# U1 also carries a mark on its own promise 2 (an update cannot answer itself): it must be ignored.
ev 28 "$ALICE" 47003 "[[\"a\",\"$A\"],[\"update-part\",\"done\",\"Started\"],[\"promise\",\"0\",\"Ship it\"],[\"promise\",\"1\",\"Tell friends\"],[\"promise\",\"2\",\"Never answered\"],[\"promise\",\"3\",\"Tidy up\"],[\"promise-mark\",\"$U1:2\",\"done\",\"\"],[\"help-needed\",\"Someone to test on a phone\"],[\"help-size\",\"small\"]]" >/dev/null
ev 21 "$ALICE" 47003 "[[\"a\",\"$A\"],[\"update-part\",\"done\",\"Shipped\"],[\"promise\",\"0\",\"Polish\"],[\"promise-mark\",\"$U1:0\",\"done\",\"\"],[\"promise-mark\",\"$U1:1\",\"not-done\",\"ran out of time\"],[\"promise-mark\",\"$U1:3\",\"done\",\"\"]]"; U2="$LAST"
ev 10 "$ALICE" 47003 "[[\"a\",\"$A\"],[\"update-part\",\"done\",\"Late\"],[\"promise\",\"0\",\"Release\"],[\"promise-mark\",\"$U1:0\",\"not-done\",\"it broke\"],[\"promise-mark\",\"$U2:0\",\"changed\",\"\"]]"; U3="$LAST"
ev 5 "$ALICE" 47003 "[[\"a\",\"$A\"],[\"update-part\",\"done\",\"Removed later\"]]" deleted >/dev/null
# A promise answer by someone who is not the founder, and a weekly-looking update by a visitor: neither counts.
ev 9 "$HELPER" 47003 "[[\"a\",\"$A\"],[\"promise-mark\",\"$U2:0\",\"done\",\"\"],[\"update-part\",\"done\",\"Not the founder\"]]" >/dev/null
# Offers: one person twice (once), the team's own (not an offer), and one on a record that is not a help request.
ev 27 "$HELPER" 47003 "[[\"a\",\"$A\"],[\"e\",\"$U1\"],[\"p\",\"$ALICE\"],[\"help-offer\",\"$U1\"]]" >/dev/null
ev 26 "$HELPER" 47003 "[[\"a\",\"$A\"],[\"e\",\"$U1\"],[\"p\",\"$ALICE\"],[\"help-offer\",\"$U1\"]]" >/dev/null
ev 26 "$MATE" 47003 "[[\"a\",\"$A\"],[\"e\",\"$U1\"],[\"p\",\"$ALICE\"],[\"help-offer\",\"$U1\"]]" >/dev/null
ev 20 "$HELPER" 47003 "[[\"a\",\"$A\"],[\"e\",\"$U2\"],[\"p\",\"$ALICE\"],[\"help-offer\",\"$U2\"]]" >/dev/null
# Tasks: one confirmed by a team member who is not the helper, one confirmed but sent back, one with nothing handed in.
task() { ev "$1" "$ALICE" 47003 "[[\"a\",\"$A\"],[\"l\",\"creaton-task\"],[\"task-part\",\"task\"],[\"p\",\"$HELPER\"],[\"task-helper\",\"$HELPER\"],[\"task-what\",\"$2\"],[\"task-done\",\"done\"]]"; }
step() { # step <days> <author> <task> <part> [evidence id]
  ev "$1" "$2" 47003 "[[\"a\",\"$A\"],[\"l\",\"creaton-task\"],[\"e\",\"$3\"],[\"task\",\"$3\"],[\"task-part\",\"$4\"]${5:+,[\"task-evidence\",\"$5\"]}]"
}
task 25 "Test sign-up"; T1="$LAST"
step 24 "$HELPER" "$T1" evidence; E1="$LAST"
step 23 "$MATE" "$T1" confirm "$E1"
task 25 "Write the guide"; T2="$LAST"
step 24 "$HELPER" "$T2" evidence; E2="$LAST"
step 23 "$ALICE" "$T2" confirm "$E2"
step 22 "$MATE" "$T2" send-back "$E2"
task 25 "Nothing handed in" >/dev/null

# Bob: one update, now 8 days old. Cara: a project with no update, 8 days old. Dan: two days old. Eve: three on time.
B="$(coord "$BOB" orbit)"
project "$BOB" 9 orbit Orbit >/dev/null
ev 8 "$BOB" 47003 "[[\"a\",\"$B\"],[\"update-kind\",\"weekly\"]]" >/dev/null
project "$CARA" 8 quiet Quiet >/dev/null
project "$DAN" 2 fresh Fresh >/dev/null
E="$(coord "$EVE" steady)"
project "$EVE" 21 steady Steady >/dev/null
for d in 20 13 6; do ev "$d" "$EVE" 47003 "[[\"a\",\"$E\"],[\"update-part\",\"done\",\"Week\"]]" >/dev/null; done
# The operator's own project, posting daily: in no number.
O="$(coord "$OPERATOR" creaton)"
project "$OPERATOR" 40 creaton Creaton >/dev/null
ev 1 "$OPERATOR" 47003 "[[\"a\",\"$O\"],[\"update-part\",\"done\",\"Ours\"]]" >/dev/null
# Fay's project is the operator's too, started from another account (BUZZ_PILOT_EXCLUDE).
F="$(coord "$FAY" mine-too)"
project "$FAY" 12 mine-too "Also ours" >/dev/null
ev 11 "$FAY" 47003 "[[\"a\",\"$F\"],[\"update-part\",\"done\",\"Ours too\"]]" >/dev/null

psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$SQL" >/dev/null 2>"$WORK/fixture.err" || { cat "$WORK/fixture.err"; echo "the fixture did not load"; exit 1; }

env_file() { printf 'RELAY_OWNER_PUBKEY=%s\nBUZZ_PILOT_EXCLUDE=%s\n' "$OPERATOR" "${1:-}" >"$COMPOSE_DIR/.env"; }
run() { (cd "$COMPOSE_DIR" && ./run.sh "$@") 2>&1; }
env_file "$FAY"

echo "--- founders --csv: each number is what the records say"
CSV="$(run founders --csv)"; status=$?
check "founders --csv exits 0" $(yes_if [ $status -eq 0 ])
row() { grep -E "^$1," <<<"$CSV"; }
# founder,project,days_live,updates,weeks_posted,per_week,update_2,update_3,days_since_last,promises,kept,missed,changed,unanswered,help_requests,offers,tasks,tasks_accepted
check "Alice's row: 3 updates, the second on time and the third after a late flag, in 3 of 5 weeks" \
  $(yes_if has "$(row Alice)" "Alice,Nebula,30,3,3 of 5,0.6,+7d,+11d after late flag,10,")
check "Alice's promises: 6 made, 1 kept, 2 missed (one answered twice, the worse counts), 1 changed, 1 never answered, help asked 1, offers 1, tasks 3, accepted 1" \
  $(yes_if has "$(row Alice)" ",10,6,1,2,1,1,1,1,3,1")
check "Bob has one update and the second is late so far" $(yes_if has "$(row b0b00000)" "Orbit,9,1,1 of 2,0.5,late: 8d so far,not yet,8,0,0,0,0,0,0,0,0,0")
check "Cara has none and is named by her key's start" $(yes_if has "$(row "ca4a0000")" "Quiet,8,0,0 of 2,0.0,not yet,not yet,none,")
check "Eve posted three on time" $(yes_if has "$(row "e4e00000")" "Steady,21,3,3 of 3,1.0,+7d,+7d,6,")
check "the operator's own project is in no row (the owner's key from .env)" $(yes_if lacks "$CSV" "Creaton")
check "a project from a key in BUZZ_PILOT_EXCLUDE is in no row" $(yes_if lacks "$CSV" "Also ours")
check "an update deleted later is not counted (Alice's last is 10 days ago, not 5)" $(yes_if lacks "$(row Alice)" ",5,6,")
check "a record by a visitor that looks like an update is not counted (still 3)" $(yes_if has "$(row Alice)" "Alice,Nebula,30,3,")

echo "--- founders: the table and its totals"
TABLE="$(run founders)"; status=$?
check "founders exits 0 and says the totals" $(yes_if bash -c '[[ $0 -eq 0 ]] && grep -q "second_after_late_flag" <<<"$1"' "$status" "$TABLE")
SUMMARY_ROW="$(grep -E '^ +[0-9]+ \| +[0-9]+ \|' <<<"$TABLE" | tail -1 | tr -d ' ')"
# founders | posted_1 | posted_2 | posted_3 | second_on_time | third_on_time | second_after_late_flag | third_after_late_flag
check "totals: 5 founders, 3 posted, 2 posted a second, 2 a third; the second on time twice, the third on time once; one third after a late flag" \
  $(yes_if [ "$SUMMARY_ROW" == "5|3|2|2|2|1|0|1" ])

echo "--- due"
DUE="$(run due --csv)"; status=$?
check "due exits 0" $(yes_if [ $status -eq 0 ])
check "due lists Alice first, 10 days since and 3 days late" $(yes_if bash -c 'sed -n 2p <<<"$0" | grep -q "^Alice,Nebula,.*,10,3,3$"' "$DUE")
check "due lists Bob (8 days, 1 late)" $(yes_if has "$DUE" ",8,1,1")
check "due lists Cara from the day her project began: no update yet" $(yes_if has "$DUE" "Quiet,no update yet,8,1,0")
check "due leaves out Eve (6 days), Dan (no update, 2 days) and the operator's own projects" \
  $(yes_if bash -c '! grep -qE "Steady|Fresh|Creaton|Also ours" <<<"$0"' "$DUE")
DUE9="$(run due --days 9 --csv)"
check "due --days 9 lists Alice alone" $(yes_if bash -c '[[ "$(wc -l <<<"$0")" -eq 2 ]] && grep -q Nebula <<<"$0"' "$DUE9")
DUE11="$(run due --days 11 --csv)"
check "due --days 11 lists nobody" $(yes_if bash -c '[[ "$(wc -l <<<"$0")" -eq 1 ]]' "$DUE11")
check "an unusable --days is refused" $(yes_if bash -c '! (cd "$0" && ./run.sh due --days 0) >/dev/null 2>&1' "$COMPOSE_DIR")

echo "--- daily: due, the last day, and the reports; a failing section fails the command"
DAILY="$(FAKE_REPORTS='report 1: spam' run daily)"; status=$?
check "daily exits 0 and shows all three parts" $(yes_if bash -c '[[ $0 -eq 0 ]] && grep -q "Founders due" <<<"$1" && grep -q "last 24 hours" <<<"$1" && grep -q "report 1: spam" <<<"$1"' "$status" "$DAILY")
check "daily's due part names Alice" $(yes_if has "$DAILY" "Nebula")
FAILED="$(FAKE_REPORTS_STATUS=3 run daily)"; status=$?
check "when the reports cannot be read, daily still prints the due list, says so, and exits non-zero" \
  $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "Nebula" <<<"$1" && grep -q "not to be read as empty" <<<"$1"' "$status" "$FAILED")

echo "--- the operator's key: bad settings stop the command instead of counting the operator in"
env_file "npub1notahexkey"
BAD="$(run founders)"; status=$?
check "an npub in BUZZ_PILOT_EXCLUDE is refused with a reason" $(yes_if bash -c '[[ $0 -ne 0 ]] && grep -q "64-character hex" <<<"$1"' "$status" "$BAD")
env_file ""
NOEXC="$(run founders --csv)"
check "without BUZZ_PILOT_EXCLUDE only the owner's key is left out (Also ours is counted)" $(yes_if has "$NOEXC" "Also ours")

echo
if [[ $failures -eq 0 ]]; then echo "all checks passed"; else echo "$failures check(s) failed"; fi
[[ $failures -eq 0 ]]
