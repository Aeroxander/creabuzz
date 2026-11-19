#!/usr/bin/env python3
"""The field-by-field half of scripts/chain-loop-pot.sh.

    python3 -I scripts/chain-loop-pot-check.py <rpc url> <record.json> [expected.json]

Reads the project numbers record (version 2) the relay signed and compares every number in it with the contracts' own views,
called with `cast` at the record's own block (`asOf.block`). A number the record carries that a view has must equal the view;
the one number no view has (the settled pot, box, arriving money) is worked forward here, on its own, from the stored views by
the rule of RECORD-V2 section 3, and compared too. The optional expected file holds amounts the loop knows from what it sent
(`{"joined": ..., "fees": ..., "drawn": ..., "outside": ..., "tookOut": ..., "holders": [...]}`).

Prints one `ok` line per check and `CHECKS <n>` at the end; exits 1 on the first difference. Public anvil keys only.
"""

import json
import subprocess
import sys

RPC, RECORD = sys.argv[1], sys.argv[2]
EXPECTED = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
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
check("version", rec["version"], 2)
check("chain id", rec["chainId"], 31337)
check("project key", rec["key"], address(LAUNCHER, "keyOf(address,bytes32)(bytes32)", rec["founder"], rec["projectId"]))
check("play money", rec["playMoney"], boolean(LAUNCHER, "testNetwork()(bool)"))
check("unit", rec["unit"], uint(T, "unit()(uint32)"))
check("platform fee", rec["fee"]["bps"], uint(T, "feeBps()(uint16)"))

# ---- the money
check("paid in", rec["money"]["paidIn"], uint(T, "paidIn()(uint256)"))
check("fees owed", rec["money"]["feesOwed"], uint(T, "feesOwed()(uint256)"))
check("locked", rec["money"]["locked"], uint(T, "locked()(uint256)"))
check("notes owed", rec["money"]["notesOwed"], uint(T, "notesOwed()(uint256)"))
check("held", rec["money"]["held"], uint(USD, "balanceOf(address)(uint256)", T))

# The settled pot, box and arriving money, worked forward here from the stored views (section 3).
last, end = uint(T, "lastSettle()(uint64)"), uint(T, "activeEnd()(uint256)")
rate, unit = uint(T, "ratePpm()(uint32)"), rec["unit"]
pot, box, arriving = uint(T, "pot()(uint256)"), uint(T, "box()(uint256)"), uint(T, "arriving()(uint256)")
active, arrival_end = uint(T, "activeSeconds()(uint256)"), uint(T, "arrivalEnd()(uint64)")
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
    released = arriving if t >= arrival_end else arriving * (t - last) // (arrival_end - last)
    arriving, pot = arriving - released, pot + released
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

# ---- the totals the loop knows from what it sent
for field in ("joined", "fees", "drawn", "outside", "tookOut"):
    if field in EXPECTED:
        check(f"total {field}", rec["totals"][field], EXPECTED[field])
check(
    "every dollar that came in is somewhere or went out",
    int(rec["totals"]["joined"]) + int(rec["totals"]["outside"]),
    sum(int(rec["totals"][k]) for k in ("fees", "tookOut", "drawn"))
    + int(rec["money"]["pot"]) + int(rec["allowance"]["box"]) + int(rec["money"]["arriving"]),
)
for who in EXPECTED.get("holders", []):
    check(f"holder {who[:8]} is listed", any(h["account"] == who for h in rec["holders"]), True)
for who in EXPECTED.get("notHolders", []):
    check(f"{who[:8]} holds nothing now", any(h["account"] == who and int(h["shares"]) > 0 for h in rec["holders"]), False)
if "firstBackedAt" in EXPECTED:
    check("first backed at is the first join's block time", rec["firstBackedAt"], EXPECTED["firstBackedAt"])

print(f"CHECKS {count}")
