#!/usr/bin/env python3
"""The field-by-field half of scripts/chain-loop-pot.sh.

    python3 -I scripts/chain-loop-pot-check.py [--stop] <rpc url> <record.json> [expected.json]

Reads the project numbers record (version 2) the relay signed and compares every number in it with the contracts' own views,
called with `cast` at the record's own block (`asOf.block`). A number the record carries that a view has must equal the view;
the one number no view has (the settled pot, box, arriving money) is worked forward here, on its own, from the stored views by
the rule of RECORD-V2 section 3 (the stream formula from `arrivalStart` and `arrivalTotal`, and the money of tasks that have run
out put back last, from the task book's `dueC`), and compared too. The optional expected file holds amounts the loop knows from
what it sent (`{"joined": ..., "fees": ..., "drawn": ..., "outside": ..., "tookOut": ..., "paidToWorkers": ..., "noteClaims": ...,
"holders": [...], "tasks": {"1": "cancelled", ...}}`).

With `--stop` (the loop's stops while tasks move) only what tasks and money can change is compared: the frame, the money, the
settled numbers, the totals and the whole task section (every row's words against `taskOf`, every listed note against `noteOf` and
`claimableNote`, the buckets, the cap, the counts and the limits). Without it, everything is, including the task section.

Prints one `ok` line per check and `CHECKS <n>` at the end; exits 1 on the first difference. Public anvil keys only.
"""

import json
import subprocess
import sys

ARGS = [a for a in sys.argv[1:] if a != "--stop"]
STOP = "--stop" in sys.argv[1:]
RPC, RECORD = ARGS[0], ARGS[1]
EXPECTED = json.load(open(ARGS[2])) if len(ARGS) > 2 else {}
rec = json.load(open(RECORD))
BLOCK = str(rec["asOf"]["block"])
count = 0


def fail(message):
    print(f"FAIL  {message}", file=sys.stderr)
    sys.exit(1)


def check(label, got, want):
    global count
    if str(got) != str(want):
        fail(f"{label}: the record says {got}, the contract says {want}")
    count += 1
    print(f"ok    {label}: {got}")


def cast(to, sig, *args):
    out = subprocess.run(
        ["cast", "call", "--rpc-url", RPC, "--block", BLOCK, to, sig, *map(str, args)],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        fail(f"cast call {sig} failed: {out.stderr.strip()[-300:]}")
    return out.stdout.strip()


def first(text):
    return text.split()[0]


def uint(to, sig, *args):
    return int(first(cast(to, sig, *args).splitlines()[0]))


def boolean(to, sig, *args):
    return first(cast(to, sig, *args)) == "true"


def address(to, sig, *args):
    return first(cast(to, sig, *args)).lower()


def tuple_of(to, sig, *args):
    """A call's several answers: one per line, or one parenthesised list (a struct)."""
    text = cast(to, sig, *args).strip()
    parts = text.splitlines() if "\n" in text else text.strip("()").split(",")
    return [part.strip().split()[0] for part in parts]


T, V = rec["contracts"]["treasury"], rec["contracts"]["vester"]
SH, TM, USD = rec["contracts"]["shares"], rec["contracts"]["team"], rec["contracts"]["dollar"]
LAUNCHER = rec["launcher"]

# ---- the record's own frame
if not STOP:
    check("version", rec["version"], 2)
    check("chain id", rec["chainId"], 31337)
    check("project key", rec["key"], address(LAUNCHER, "keyOf(address,bytes32)(bytes32)", rec["founder"], rec["projectId"]))
    check("play money", rec["playMoney"], boolean(LAUNCHER, "testNetwork()(bool)"))
    check("unit", rec["unit"], uint(T, "unit()(uint32)"))
    check("platform fee", rec["fee"]["bps"], uint(T, "feeBps()(uint16)"))

# ---- the money
check("paid in", rec["money"]["paidIn"], uint(T, "paidIn()(uint256)"))
check("fees owed", rec["money"]["feesOwed"], uint(T, "feesOwed()(uint256)"))
BOOK = rec["tasks"]["book"] if rec.get("tasks") else None
T_NOW = rec["asOf"]["time"]
# The money of tasks that ran out is back in the pot as far as the record is concerned (the next settle makes it so).
DUE_C = uint(BOOK, "dueC(uint256)(uint256)", T_NOW) if BOOK else 0
check("locked (settled: the Treasury's locked() less what has run out)", rec["money"]["locked"], uint(T, "locked()(uint256)") - DUE_C)
check("notes owed", rec["money"]["notesOwed"], uint(T, "notesOwed()(uint256)"))
check("held", rec["money"]["held"], uint(USD, "balanceOf(address)(uint256)", T))

# The settled pot, box and arriving money, worked forward here from the stored views (section 3).
last, end = uint(T, "lastSettle()(uint64)"), uint(T, "activeEnd()(uint256)")
rate, unit = uint(T, "ratePpm()(uint32)"), rec["unit"]
pot, box, arriving = uint(T, "pot()(uint256)"), uint(T, "box()(uint256)"), uint(T, "arriving()(uint256)")
active, arrival_end = uint(T, "activeSeconds()(uint256)"), uint(T, "arrivalEnd()(uint64)")
arrival_start, arrival_total = uint(T, "arrivalStart()(uint64)"), uint(T, "arrivalTotal()(uint256)")
t = rec["asOf"]["time"]
dt = max(min(t, end) - last, 0)
cap = pot + box
cap = cap * rate * 7 // 1_000_000
if dt and rate:
    to_box = pot * rate * dt // (1_000_000 * (unit // 7))
    box, pot = box + to_box, pot - to_box
if box > cap:
    pot, box = pot + box - cap, cap
if arriving:
    # what has arrived by now is one rounding of one formula on the stream's own start
    target = arrival_total if t >= arrival_end else arrival_total * (t - arrival_start) // (arrival_end - arrival_start)
    done = arrival_total - arriving
    released = target - done if target > done else 0
    arriving, pot = arriving - released, pot + released
# tasks that have run out come back last: the returned money is not charged allowance for time it was not in the pot
pot += DUE_C
active += dt
check("settled pot", rec["money"]["pot"], pot)
check("settled box", rec["allowance"]["box"], box)
check("settled arriving money", rec["money"]["arriving"], arriving)
check("settled active seconds", rec["clock"]["activeSeconds"], active)
check("active seconds are the contract's own activeNow", rec["clock"]["activeSeconds"], uint(T, "activeNow()(uint256)"))
check("box cap is the contract's own", rec["allowance"]["boxCap"], uint(T, "boxCap()(uint256)"))
check("arrival end", rec["money"]["arrivalEnd"], arrival_end if arriving else None)
check("the stored pot (for checks)", rec["ledger"]["pot"], uint(T, "pot()(uint256)"))
check("the stored box (for checks)", rec["ledger"]["box"], uint(T, "box()(uint256)"))
check("the stored arriving money (for checks)", rec["ledger"]["arriving"], uint(T, "arriving()(uint256)"))
check("the stored active seconds (for checks)", rec["ledger"]["activeSeconds"], uint(T, "activeSeconds()(uint256)"))
check("the stored last settle (for checks)", rec["ledger"]["lastSettle"], last)
check("the stored stream start (for checks)", rec["ledger"]["arrivalStart"], arrival_start)
check("the stored stream total (for checks)", rec["ledger"]["arrivalTotal"], arrival_total)
check("the stored locked money (for checks)", rec["ledger"]["locked"], uint(T, "locked()(uint256)"))
check("the stored notes owed (for checks)", rec["ledger"]["notesOwed"], uint(T, "notesOwed()(uint256)"))

if not STOP:
    # ---- Shares and what one is worth
    check("backer Shares", rec["shares"]["backers"], uint(SH, "totalSupply()(uint256)"))
    check("Team Shares counted", rec["shares"]["teamCounted"], uint(TM, "totalSupply()(uint256)"))
    check("Team Shares announced to burn", rec["shares"]["announcedBurn"], uint(T, "Z()(uint256)"))
    check("leave value", rec["value"]["leaveValue"], uint(T, "leaveValue()(uint256)"))
    check("team value", rec["value"]["teamValue"], uint(T, "teamValue()(uint256)"))

    # ---- the allowance, the clock, the door
    check("rate", rec["allowance"]["ratePpm"], rate)
    pending_at = uint(T, "pendingAt()(uint64)")
    if pending_at:
        check("pending rate", rec["allowance"]["pending"]["ratePpm"], uint(T, "pendingRatePpm()(uint32)"))
        check("pending since", rec["allowance"]["pending"]["proposedAt"], pending_at)
        check("pending applicable from", rec["allowance"]["pending"]["applicableAt"], pending_at + unit)
    else:
        check("no pending rate", rec["allowance"]["pending"], None)
    check("last check-in", rec["clock"]["lastCheckIn"], uint(T, "lastCheckIn()(uint64)"))
    check("active until", rec["clock"]["activeUntil"], end or None)
    check("door switch", rec["door"]["switchOn"], boolean(T, "doorFlag()(bool)"))
    check("door open now", rec["door"]["openNow"], boolean(T, "doorOpenNow()(bool)"))
    check("door shuts at", rec["door"]["shutsAt"], end or None)
    check("wind-down kind", 0 if rec["windDown"] is None else rec["windDown"]["kind"], uint(T, "windDownKind()(uint8)"))
    check("quiet state of a living project", rec["quiet"]["state"], "active")
    check("runner", rec["runner"]["address"], address(T, "runner()(address)"))
    check("runner is a pair", rec["runner"]["isPair"], boolean(LAUNCHER, "isPair(address)(bool)", rec["runner"]["address"]))

    # ---- Team Shares and grants
    check("Team Shares held by the Vester", rec["team"]["inVester"], uint(TM, "balanceOf(address)(uint256)", V))
    check("Team Shares promised", rec["team"]["promised"], uint(V, "committed()(uint256)"))
    check("grant count", rec["team"]["grantCount"], uint(V, "grantCount()(uint256)"))
    for g in rec["team"]["grants"]:
        gid = g["id"]
        member, protected, state, burn_at, total, claimed, start, burn = tuple_of(
            V, "grantOf(uint256)((address,bool,uint8,uint64,uint256,uint256,uint256,uint256))", gid
        )
        check(f"grant {gid} member", g["member"], member.lower())
        check(f"grant {gid} keeps", g["keeps"], total)
        check(f"grant {gid} claimed", g["claimed"], claimed)
        check(f"grant {gid} start", g["startActive"], start)
        check(f"grant {gid} vested", g["vested"], uint(V, "vestedOf(uint256)(uint256)", gid))
        check(f"grant {gid} claimable", g["claimable"], uint(V, "claimable(uint256)(uint256)", gid))
        check(f"grant {gid} state", g["state"], ["live", "announced", "closed"][int(state)])

    # ---- agents
    for a in rec["agents"]:
        active_flag, usd_cap, share_cap = tuple_of(T, "agents(address)(bool,uint128,uint128)", a["agent"])
        live = active_flag == "true" and uint(T, "agentEpochOf(address)(uint256)", a["agent"]) == uint(T, "agentEpoch()(uint256)")
        check(f"agent {a['agent'][:8]} live", a["live"], live)
        check(f"agent {a['agent'][:8]} dollar limit", a["usdCap"], usd_cap)
        check(f"agent {a['agent'][:8]} Team Share limit", a["teamCap"], share_cap)
        check(f"agent {a['agent'][:8]} used", a["usdUsed"], uint(T, "agentUsdUsed(address)(uint256)", a["agent"]))

    # ---- limits, from the contracts
    for name, sig, view in [
        ("smallest join", "minJoin", "MIN_JOIN()(uint256)"),
        ("smallest outside payment", "minOutsidePayment", "MIN_REVENUE()(uint256)"),
        ("rate ceiling", "maxRatePpm", "MAX_RATE_PPM()(uint32)"),
        ("check-in window", "checkInWindowUnits", "CHECK_IN_MULT()(uint256)"),
        ("wind-down length", "windDownUnits", "WIND_MULT()(uint256)"),
        ("agent dollars a day", "agentUsdPerDay", "agentUsd()(uint128)"),
        ("agent Team Shares a day", "agentTeamPerDay", "agentTeam()(uint128)"),
    ]:
        check(name, rec["limits"][sig], uint(T, view))
    for name, sig, view in [
        ("vesting cliff", "cliffUnits", "CLIFF_MULT()(uint256)"),
        ("vesting length", "vestUnits", "VEST_MULT()(uint256)"),
        ("smallest grant", "minGrant", "MIN_GRANT()(uint256)"),
        ("grants one member can get", "maxGrantsPerMember", "MAX_GRANTS_PER_MEMBER()(uint256)"),
    ]:
        check(name, rec["limits"][sig], uint(V, view))

    # ---- holders, balance by balance
    for h in rec["holders"]:
        check(f"Shares of {h['account'][:8]}", h["shares"], uint(SH, "balanceOf(address)(uint256)", h["account"]))
        check(f"Team Shares of {h['account'][:8]}", h["teamShares"], uint(TM, "balanceOf(address)(uint256)", h["account"]))
    check("every holder is listed (Shares)", sum(int(h["shares"]) for h in rec["holders"]), uint(SH, "totalSupply()(uint256)"))
    check("the lists are whole", rec["truncated"], False)

# ---- the task queue: the book, its limits, every row against `taskOf`, every listed note against `noteOf`
STATES = ["none", "announced", "taken", "paid", "rejected", "returned", "cancelled", "lapsed"]
ZERO = "0x" + "00" * 20
TASK_OF_TYPES = (
    "bytes32,address,uint8,uint16,uint8,address,uint64,uint64,uint64,uint64,uint64,uint128,uint128,uint128,uint128,uint128,uint128"
)
TASK_OF_NAMES = (
    "what payee state shareBps ringIdx takenBy announcedAt noticeEnd expiresAt takenAt deadline maxDollars locked stayer noteFace "
    "returned notesLeft"
).split()
tk = rec.get("tasks")
check("the record has a task section (the launch made a task book)", tk is not None, True)
check("tasks.book is the Treasury's tasks()", tk["book"], address(T, "tasks()(address)"))
check("tasks.nextSerial", tk["nextSerial"], uint(BOOK, "nextSerial()(uint64)"))
check("tasks.openCount", tk["openCount"], uint(BOOK, "openCount()(uint8)"))
next_expiry = uint(T, "nextExpiry()(uint64)")
check("tasks.nextExpiry is the Treasury's own", tk["nextExpiry"], next_expiry or None)
lim = tk["limits"]
for name, view in [
    ("open tasks at most", "MAX_OPEN()(uint256)"),
    ("share of the pot at most", "MAX_SHARE_BPS()(uint256)"),
    ("take cap", "CAP_BPS()(uint256)"),
    ("smallest task", "MIN_TASK()(uint256)"),
]:
    key = {"open tasks at most": "maxOpen", "share of the pot at most": "maxShareBps", "take cap": "capBps", "smallest task": "minTask"}[name]
    check(f"limit: {name}", lim[key], uint(BOOK, view))
notice = tuple_of(BOOK, "noticeFor(uint16)(uint256,uint256,uint256)", 1)
check("limit: the take window", lim["takeWindowSecs"], notice[1])
check("limit: due after a take", lim["dueSecs"], notice[2])
check("limit: the cap's window", lim["capWindowSecs"], uint(BOOK, "CAP_WINDOW_MULT()(uint256)") * rec["unit"])

rows = tk["list"]
# Which tasks the list holds (RECORD-V2 section 10): every open one, every ended one that still has money for a leaver to claim,
# and every ended one that ended inside the cap's window of 28 days. The loop knows when it ended each task (`endedAt`), the
# contract knows who holds notes; nothing here is read from the record but the list itself.
serials = list(range(1, tk["nextSerial"]))
ended_at = {int(k): v for k, v in EXPECTED.get("endedAt", {}).items()}
window_secs = uint(BOOK, "CAP_WINDOW_MULT()(uint256)") * rec["unit"]
check("the list's age limit is the cap's window", tk["cut"]["endedWithinSecs"], window_secs)
want_listed = []
for serial in serials:
    words = dict(zip(TASK_OF_NAMES, tuple_of(BOOK, f"taskOf(uint64)({TASK_OF_TYPES})", serial)))
    state, notes_left = int(words["state"]), int(words["notesLeft"])
    if state in (1, 2) or notes_left > 0:
        want_listed.append(serial)
    elif serial not in ended_at:
        fail(f"the loop does not know when task {serial} ended")
    elif ended_at[serial] + window_secs > T_NOW:
        want_listed.append(serial)
check(
    "the list holds the open tasks, those with money left to claim and those that ended inside the window, and no other",
    sorted(r["serial"] for r in rows),
    want_listed,
)
check("nothing eligible is dropped from the list or its notes", [tk["cut"]["endedDropped"], tk["cut"]["notesRowsDropped"], tk["truncated"]], [0, 0, False])
overdue = [r for r in rows if r["state"] == "taken" and r["deadline"] <= T_NOW]
for row in rows:
    serial = row["serial"]
    got = dict(zip(TASK_OF_NAMES, tuple_of(BOOK, f"taskOf(uint64)({TASK_OF_TYPES})", serial)))
    want = {
        "what": row["what"],
        "payee": row["payee"] or ZERO,
        "state": STATES.index(row["state"]),
        "shareBps": row["shareBps"],
        "takenBy": row["takenBy"] or ZERO,
        "announcedAt": row["announcedAt"],
        "noticeEnd": row["noticeEnd"],
        "expiresAt": row["expiresAt"],
        "takenAt": row["takenAt"] or 0,
        "deadline": row["deadline"] or 0,
        "maxDollars": row["maxDollars"],
        "locked": row["setAside"],
        "stayer": row["stayerClaim"],
        "noteFace": row["noteFace"],
        "returned": row["returned"],
        "notesLeft": row["notesLeft"],
    }
    got = {k: (v.lower() if str(v).startswith("0x") else v) for k, v in got.items() if k != "ringIdx"}
    differ = [f"{k}: record {want[k]}, contract {got[k]}" for k in want if str(want[k]) != str(got[k])]
    check(f"task {serial} ({row['state']}): all 16 words of taskOf", "; ".join(differ) or "equal", "equal")
    if row["state"] == "announced" and T_NOW < row["expiresAt"]:
        share = int(rec["money"]["pot"]) * row["shareBps"] // 10_000
        check(f"task {serial}: what taking it now would set aside", row["atMostNow"], min(int(row["maxDollars"]), share))
    else:
        check(f"task {serial}: no amount is promised once it cannot be taken", row["atMostNow"], None)
    check(
        f"task {serial}: paid plus sent back is what was set aside",
        int(row["pay"]) + int(row["returned"]),
        int(row["setAside"]) if row["state"] in ("paid", "rejected", "returned") else 0,
    )
    notes = row["notes"]
    if notes is not None:
        check(f"task {serial}: its note holders add up to the face", sum(int(h["face"]) for h in notes["holders"]), row["noteFace"])
        for h in notes["holders"]:
            who = h["account"]
            check(f"task {serial}: noteOf {who[:8]}", h["face"], uint(BOOK, "noteOf(uint64,address)(uint256)", serial, who))
            chain_claim = uint(BOOK, "claimableNote(uint64,address)(uint256)", serial, who)
            late = row["state"] == "taken" and row["deadline"] <= T_NOW
            check(f"task {serial}: claimable {who[:8]}", h["claimable"], h["face"] if late else chain_claim)

# the buckets and the cap
taken_open = [r for r in rows if r["state"] == "taken" and r["deadline"] > T_NOW]
check("money.locked is the stayers' claims of the tasks still running", sum(int(r["stayerClaim"]) for r in taken_open), rec["money"]["locked"])
check(
    "money set aside is stayers plus notes for every taken task (C + N = L)",
    [int(r["stayerClaim"]) + int(r["noteFace"]) for r in rows if r["state"] == "taken"],
    [int(r["setAside"]) for r in rows if r["state"] == "taken"],
)
check(
    "notes owed are the face of open tasks' notes and what is left of ended ones'",
    rec["money"]["notesOwed"],
    sum(int(r["noteFace"]) if r["state"] in ("announced", "taken") else int(r["notesLeft"]) for r in rows),
)
pending_back = sum(r["capBps"] for r in overdue)
window = uint(BOOK, "windowSumBps()(uint256)")
check("cap.usedBps is the book's window sum less what the next settle gives back", tk["cap"]["usedBps"], window - pending_back)
check("cap.roomBps is the book's take room plus what the next settle gives back", tk["cap"]["roomBps"], uint(BOOK, "takeRoomBps()(uint256)") + pending_back)
check("cap.frees add up to what is used", sum(f["bps"] for f in tk["cap"]["frees"]), tk["cap"]["usedBps"])
for serial, state in EXPECTED.get("tasks", {}).items():
    chain_state = STATES[int(tuple_of(BOOK, f"taskOf(uint64)({TASK_OF_TYPES})", serial)[2])]
    check(f"task {serial} is {state} on the chain, as the loop left it", chain_state, state)

# ---- the totals the loop knows from what it sent
for field in ("joined", "fees", "drawn", "outside", "tookOut", "paidToWorkers", "noteClaims"):
    if field in EXPECTED:
        check(f"total {field}", rec["totals"][field], EXPECTED[field])
check(
    "every dollar that came in is somewhere or went out",
    int(rec["totals"]["joined"]) + int(rec["totals"]["outside"]),
    sum(int(rec["totals"][k]) for k in ("fees", "tookOut", "drawn"))
    + int(rec["totals"]["paidToWorkers"]) + int(rec["totals"]["noteClaims"])
    + int(rec["money"]["pot"]) + int(rec["allowance"]["box"]) + int(rec["money"]["arriving"])
    + int(rec["money"]["locked"]) + int(rec["money"]["notesOwed"]),
)
check(
    "the dollars held are the pot, the box, what is arriving, the fee owed, the money set aside and the notes",
    rec["money"]["held"],
    sum(int(x) for x in (rec["money"]["pot"], rec["allowance"]["box"], rec["money"]["arriving"], rec["money"]["feesOwed"],
                         rec["money"]["locked"], rec["money"]["notesOwed"])),
)
for who in EXPECTED.get("holders", []):
    check(f"holder {who[:8]} is listed", any(h["account"] == who for h in rec["holders"]), True)
for who in EXPECTED.get("notHolders", []):
    check(f"{who[:8]} holds nothing now", any(h["account"] == who and int(h["shares"]) > 0 for h in rec["holders"]), False)
if "firstBackedAt" in EXPECTED:
    check("first backed at is the first join's block time", rec["firstBackedAt"], EXPECTED["firstBackedAt"])

print(f"CHECKS {count}")
