#!/usr/bin/env python3
"""Checks the example record against the contracts, field by field, with `cast call` at the record's own block.

    python3 -I scripts/chain-reader-example-check.py [record.json]
    python3 -I scripts/chain-reader-example-check.py --pause [record.json]   # the second example (the holder pause and the earlier grants on)
    python3 -I scripts/chain-reader-example-check.py --council [record.json] # the third example (the holder pause and the Council on)

It plays the same run the chain reader's fixture is made from (scripts/chain-reader-fixture.py, on a fresh anvil: the chain's clock is
fixed, so the same run gives the same blocks and addresses), keeps the chain, and then asks the contracts again, with `cast call --block`,
for everything the example record (docs/next-version/record-v2-example.json) says at `asOf.block`: every field of every task row, every
listed holder's note and claim, the buckets, the cap, the limits, the stream and the contracts' settled views. It reads nothing the
server wrote except the example file itself, and none of the fixture's recorded answers: the numbers it compares with are asked of the
chain by `cast` here. It prints one line per group and the number of checks, and exits non-zero on any difference.

Step 3 adds an independent recomputation of the four social keys (`held`, `feed`, `streaks`, `established`): from the run's own raw
logs (topics and data, decoded here by position, sharing no code with the Rust) and the contracts' balances, supply and per-Share figure
at the example block, asked of the chain with `cast`.

Needs `anvil`, `cast` and `forge` (FOUNDRY_BIN, a folder holding them, or PATH) and a contracts/pot build. Public anvil keys only; the port
is a free one; anvil is stopped at the end.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("chain_reader_fixture", os.path.join(HERE, "chain-reader-fixture.py"))
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)

_social_spec = importlib.util.spec_from_file_location("chain_social_recompute", os.path.join(HERE, "chain-social-recompute.py"))
social = importlib.util.module_from_spec(_social_spec)
_social_spec.loader.exec_module(social)

PAUSE_RUN = "--pause" in sys.argv[1:]
COUNCIL_RUN = "--council" in sys.argv[1:]
_args = [a for a in sys.argv[1:] if a not in ("--pause", "--council")]
EXAMPLE = _args[0] if _args else os.path.join(
    fx.REPO,
    "docs",
    "next-version",
    "record-v2-example-council.json" if COUNCIL_RUN
    else ("record-v2-example-pause.json" if PAUSE_RUN else "record-v2-example.json"),
)
STATES = {"announced": 1, "taken": 2, "paid": 3, "rejected": 4, "returned": 5, "cancelled": 6, "lapsed": 7}
ZERO = "0x" + "00" * 20
TASK_OF_TYPES = (
    "bytes32,address,uint8,uint16,uint8,address,uint64,uint64,uint64,uint64,uint64,uint128,uint128,uint128,uint128,uint128,uint128"
)
TASK_OF_NAMES = (
    "what payee state shareBps ringIdx takenBy announcedAt noticeEnd expiresAt takenAt deadline maxDollars locked stayer noteFace "
    "returned notesLeft"
).split()

checks = 0
failures = []


def cast(block, to, sig, *args):
    """One `cast call` at `block`: the decoded answers as a list of text."""
    out = fx.run(["cast", "call", "--rpc-url", fx.RPC, "--block", str(block), "--json", to, sig, *[str(a) for a in args]])
    values = json.loads(out)
    return [str(v).split(" ")[0] if isinstance(v, str) else str(v) for v in values]


def num(block, to, sig, *args):
    return int(cast(block, to, sig, *args)[0])


def same(what, record, chain):
    global checks
    checks += 1
    if str(record) != str(chain):
        failures.append(f"{what}: the record says {record}, the contract says {chain}")


def lower(a):
    return a.lower()


def main():
    example = json.load(open(EXAMPLE))
    block, now = example["asOf"]["block"], example["asOf"]["time"]
    tmp = tempfile.mkdtemp(prefix="chain-reader-example-check-")
    anvil = subprocess.Popen(
        ["anvil", "--port", str(fx.PORT), "--silent", "--timestamp", str(fx.GENESIS)],
        stdout=open(os.path.join(tmp, "anvil.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(100):
            try:
                fx.rpc("eth_chainId")
                break
            except Exception:
                time.sleep(0.2)
        fx.rpc("anvil_setBlockTimestampInterval", 1)
        if COUNCIL_RUN:
            played = fx.play_council(tmp)
            check_council(example, block, now, played)
        elif PAUSE_RUN:
            played = fx.play_pause(tmp)
            check_pause(example, block, now, played)
        else:
            played = fx.play(tmp)
            check(example, block, now, played)
    finally:
        anvil.terminate()
        anvil.wait()
        shutil.rmtree(tmp, ignore_errors=True)
    if failures:
        print(f"{len(failures)} of {checks} checks FAILED:")
        for f in failures:
            print("  " + f)
        sys.exit(1)
    print(f"all {checks} checks passed: the example record is what the contracts say at block {block}")


def check(r, block, now, played):
    global checks
    t, book = r["contracts"]["treasury"], r["tasks"]["book"]
    # The record is for the block the fixture marks, on the same chain.
    same("the example block", block, played["books"]["A_example"]["block"])
    same("asOf.time", now, int(fx.rpc("eth_getBlockByNumber", hex(block), False)["timestamp"], 16))
    same("project key", r["key"], played["projects"]["A"]["key"])
    for name in ("treasury", "shares", "team", "vester"):
        same(f"contracts.{name}", r["contracts"][name], played["projects"]["A"][name])
    same("contracts.dollar", r["contracts"]["dollar"], played["dollar"])
    same("tasks.book is Treasury.tasks()", book, lower(cast(block, t, "tasks()(address)")[0]))
    same("tasks.book is the run's book", book, played["projects"]["A"]["tasks"])

    # The Treasury's stored numbers (the ledger section), and what the record says is settled.
    L = r["ledger"]
    for field, sig in (("pot", "pot()(uint256)"), ("box", "box()(uint256)"), ("arriving", "arriving()(uint256)"),
                       ("arrivalTotal", "arrivalTotal()(uint256)"), ("locked", "locked()(uint256)"),
                       ("notesOwed", "notesOwed()(uint256)")):
        same(f"ledger.{field}", L[field], num(block, t, sig))
    same("ledger.lastSettle", L["lastSettle"], num(block, t, "lastSettle()(uint64)"))
    same("ledger.arrivalStart", L["arrivalStart"], num(block, t, "arrivalStart()(uint64)"))
    same("ledger.activeSeconds", L["activeSeconds"], num(block, t, "activeSeconds()(uint256)"))
    arrival_end = num(block, t, "arrivalEnd()(uint64)")
    same("money.arrivalEnd", r["money"]["arrivalEnd"], arrival_end if r["money"]["arriving"] != "0" else None)
    due_c = num(block, book, "dueC(uint256)(uint256)", now)
    same("money.locked (settled: locked() less dueC)", r["money"]["locked"], num(block, t, "locked()(uint256)") - due_c)
    same("money.notesOwed", r["money"]["notesOwed"], num(block, t, "notesOwed()(uint256)"))
    same("money.paidIn", r["money"]["paidIn"], num(block, t, "paidIn()(uint256)"))
    same("money.feesOwed", r["money"]["feesOwed"], num(block, t, "feesOwed()(uint256)"))
    same("money.held", r["money"]["held"], num(block, r["contracts"]["dollar"], "balanceOf(address)(uint256)", t))
    # The settled pot and box are not views; the contracts' own settled views are made from them.
    pot, box, paid_in = int(r["money"]["pot"]), int(r["allowance"]["box"]), int(r["money"]["paidIn"])
    rate = int(r["allowance"]["ratePpm"])
    same("allowance.boxCap (settled pot and box)", r["allowance"]["boxCap"], num(block, t, "boxCap()(uint256)"))
    same("boxCap is mulDiv(pot + box, rate * 7, 1e6)", (pot + box) * rate * 7 // 1_000_000, num(block, t, "boxCap()(uint256)"))
    same("clock.activeSeconds is activeNow()", r["clock"]["activeSeconds"], num(block, t, "activeNow()(uint256)"))
    backers, counted = int(r["shares"]["backers"]), int(r["shares"]["teamCounted"])
    a1 = min(pot, paid_in)
    one = 10**18
    same("value.leaveValue is made from the settled pot", r["value"]["leaveValue"], num(block, t, "leaveValue()(uint256)"))
    same("the settled pot gives leaveValue", one * a1 // backers + one * (pot - a1) // (backers + counted), num(block, t, "leaveValue()(uint256)"))
    # Step 4: this deployment has neither switch on, so the Treasury has no gate and every step 4 key is null.
    same("contracts.pause is null: the Treasury has no pause", r["contracts"]["pause"], None)
    same("the Treasury's pauseGate() is zero", lower(cast(block, t, "pauseGate()(address)")[0]), ZERO)
    same("pause is null", r["pause"], None)
    same("earlierGrants is null", r["earlierGrants"], None)
    same("team.earlierPool is null", r["team"]["earlierPool"], None)
    same("team.earlierReserve is null", r["team"]["earlierReserve"], None)
    same("the Launcher has no claim contract", lower(cast(block, r["launcher"], "earlier()(address)")[0]), ZERO)
    print(f"the Treasury, the stream and the settled numbers: {checks} checks so far")

    # The task section.
    tk = r["tasks"]
    same("tasks.nextSerial", tk["nextSerial"], num(block, book, "nextSerial()(uint64)"))
    same("tasks.openCount", tk["openCount"], num(block, book, "openCount()(uint8)"))
    ne = num(block, t, "nextExpiry()(uint64)")
    same("tasks.nextExpiry", tk["nextExpiry"], ne if ne else None)
    lim = tk["limits"]
    unit = r["unit"]
    same("limits.maxOpen", lim["maxOpen"], num(block, book, "MAX_OPEN()(uint256)"))
    same("limits.maxShareBps", lim["maxShareBps"], num(block, book, "MAX_SHARE_BPS()(uint256)"))
    same("limits.capBps", lim["capBps"], num(block, book, "CAP_BPS()(uint256)"))
    same("limits.minTask", lim["minTask"], num(block, book, "MIN_TASK()(uint256)"))
    same("limits.capWindowSecs", lim["capWindowSecs"], num(block, book, "CAP_WINDOW_MULT()(uint256)") * unit)
    notice = cast(block, book, "noticeFor(uint16)(uint256,uint256,uint256)", 1)
    same("limits.takeWindowSecs", lim["takeWindowSecs"], notice[1])
    same("limits.dueSecs", lim["dueSecs"], notice[2])
    rows = tk["list"]
    pending = sum(row["capBps"] for row in rows if row["state"] == "taken" and row["deadline"] <= now)
    window = num(block, book, "windowSumBps()(uint256)")
    same("cap.usedBps is windowSumBps() less what the next settle gives back", tk["cap"]["usedBps"], window - pending)
    same("cap.roomBps is takeRoomBps() plus what the next settle gives back", tk["cap"]["roomBps"], num(block, book, "takeRoomBps()(uint256)") + pending)
    same("cap.frees add up to usedBps", sum(f["bps"] for f in tk["cap"]["frees"]), tk["cap"]["usedBps"])
    same("openCount is the open rows", tk["openCount"], sum(1 for row in rows if row["state"] in ("announced", "taken")))
    print(f"the book's counters and limits: {checks} checks so far")

    # Every row, every field of taskOf.
    start = checks
    for row in rows:
        s = row["serial"]
        got = dict(zip(TASK_OF_NAMES, cast(block, book, f"taskOf(uint64)({TASK_OF_TYPES})", s)))
        same(f"task {s} what", row["what"], got["what"])
        same(f"task {s} payee", row["payee"], None if got["payee"].lower() == ZERO else got["payee"].lower())
        same(f"task {s} state", STATES[row["state"]], got["state"])
        same(f"task {s} shareBps", row["shareBps"], got["shareBps"])
        same(f"task {s} takenBy", row["takenBy"], None if got["takenBy"].lower() == ZERO else got["takenBy"].lower())
        same(f"task {s} announcedAt", row["announcedAt"], got["announcedAt"])
        same(f"task {s} noticeEnd", row["noticeEnd"], got["noticeEnd"])
        same(f"task {s} expiresAt", row["expiresAt"], got["expiresAt"])
        same(f"task {s} takenAt", row["takenAt"], int(got["takenAt"]) or None)
        same(f"task {s} deadline", row["deadline"], int(got["deadline"]) or None)
        same(f"task {s} maxDollars", row["maxDollars"], got["maxDollars"])
        same(f"task {s} setAside is locked", row["setAside"], got["locked"])
        same(f"task {s} stayerClaim is stayer", row["stayerClaim"], got["stayer"])
        same(f"task {s} noteFace", row["noteFace"], got["noteFace"])
        same(f"task {s} returned", row["returned"], got["returned"])
        same(f"task {s} notesLeft", row["notesLeft"], got["notesLeft"])
        same(f"task {s} pay plus returned is what was set aside", int(row["pay"]) + int(row["returned"]),
             int(row["setAside"]) if row["state"] in ("paid", "rejected", "returned") else 0)
        if row["state"] == "announced" and now < row["expiresAt"]:
            share = int(r["money"]["pot"]) * row["shareBps"] // 10_000
            same(f"task {s} atMostNow", row["atMostNow"], min(int(row["maxDollars"]), share))
        else:
            same(f"task {s} atMostNow", row["atMostNow"], None)
        # The notes: each listed holder's note and claim from the contract.
        notes = row["notes"]
        if notes is not None:
            same(f"task {s} notes.faceTotal is noteFace", notes["faceTotal"], row["noteFace"])
            for h in notes["holders"]:
                who = h["account"]
                same(f"task {s} noteOf({who})", h["face"], num(block, book, "noteOf(uint64,address)(uint256)", s, who))
                overdue = row["state"] == "taken" and row["expiresAt"] <= now
                chain = num(block, book, "claimableNote(uint64,address)(uint256)", s, who)
                same(f"task {s} claimable of {who}", h["claimable"], h["face"] if overdue else chain)
    print(f"{len(rows)} task rows, every field, the notes and the claims: {checks - start} checks")
    start = checks
    check_social(r, block, now, played)
    print(f"the four social keys, recomputed from the raw logs: {checks - start} checks")


def check_pause(r, block, now, played):
    """The second example against the contracts: the frame, the holder pause, the claim contract, the team's two fields and the
    holdings (a parked Share is its owner's)."""
    z = played["projects"]["Z"]
    t, v, sh, tm = z["treasury"], z["vester"], z["shares"], z["team"]
    pause, claims = z["pause"], z["earlier"]
    same("the example block", block, played["books"]["Z_paused"]["block"])
    same("asOf.time", now, int(fx.rpc("eth_getBlockByNumber", hex(block), False)["timestamp"], 16))
    same("project key", r["key"], z["key"])
    same("contracts.pause is the Treasury's pauseGate()", r["contracts"]["pause"], lower(cast(block, t, "pauseGate()(address)")[0]))
    same("contracts.pause is the run's pause", r["contracts"]["pause"], pause)
    p = r["pause"]
    same("pause.contract", p["contract"], pause)
    same("pause.parkedTotal", p["parkedTotal"], num(block, pause, "parkedTotal()(uint256)"))
    same("pause.line", p["line"], num(block, pause, "line()(uint256)"))
    same("pause.line is a third of the backers' Shares, rounded up", p["line"], -(-num(block, sh, "totalSupply()(uint256)") // 3))
    same("pause.dayLength", p["dayLength"], num(block, pause, "day()(uint32)"))
    same("pause.dayLength is a seventh of the unit", p["dayLength"], r["unit"] // 7)
    same("pause.lineDivisor", p["lineDivisor"], num(block, pause, "LINE_DIVISOR()(uint256)"))
    armed = num(block, pause, "armedAt()(uint64)")
    same("pause.armedAt", p["armedAt"], armed or None)
    same("pause.pausesFrom", p["pausesFrom"], num(block, pause, "pausesFrom()(uint256)") or None)
    same("pause.paused (the contract's own answer at the block)", p["paused"], cast(block, pause, "paused()(bool)")[0] == "true")
    same("pause.since", p["since"], p["pausesFrom"] if p["paused"] else None)
    same("the pause is on in the example", p["paused"], True)
    same("shares.backers", r["shares"]["backers"], num(block, sh, "totalSupply()(uint256)"))
    same("shares.teamCounted includes the earlier pool", r["shares"]["teamCounted"], num(block, tm, "totalSupply()(uint256)"))
    # The parkers: how many accounts have Shares parked (a count only; the contract has no list, so the accounts of the run are asked).
    parkers = [a for a in played["accounts"].values() if num(block, pause, "parkedOf(address)(uint256)", a) > 0]
    same("pause.parkerCount", p["parkerCount"], len(parkers))
    # The claim contract.
    e = r["earlierGrants"]
    same("earlierGrants.contract", e["contract"], claims)
    same("earlierGrants.bound", e["bound"], lower(cast(block, claims, "vester()(address)")[0]) == v)
    same("earlierGrants.root", e["root"], cast(block, claims, "root()(bytes32)")[0].lower())
    same("earlierGrants.textHash", e["textHash"], cast(block, claims, "textHash()(bytes32)")[0].lower())
    same("earlierGrants.textHash is the run's text", e["textHash"], played["textHash"])
    same("earlierGrants.total", e["total"], num(block, claims, "total()(uint256)"))
    same("earlierGrants.rows", e["rows"], num(block, claims, "rows()(uint32)"))
    same("earlierGrants.claimedRows", e["claimedRows"], num(block, claims, "claimedRows()(uint32)"))
    same("earlierGrants.claimedTotal", e["claimedTotal"], num(block, claims, "claimedTotal()(uint256)"))
    same("earlierGrants.clockSecs", e["clockSecs"], num(block, v, "PROTECTED_LENGTH()(uint256)"))
    same("the Launcher's claim contract", lower(cast(block, r["launcher"], "earlier()(address)")[0]), claims)
    same("the Launcher's claim key is this project", cast(block, r["launcher"], "earlierKey()(bytes32)")[0].lower(), r["key"])
    # The team's fields.
    T = r["team"]
    same("team.pool is the founder's pool only", T["pool"], str(10_000_000 * 10**18))
    same("team.earlierPool", T["earlierPool"], e["total"])
    same("team.earlierReserve is the Vester's own", T["earlierReserve"], num(block, v, "earlierReserve()(uint256)"))
    same("team.earlierReserve is the pool less the claims", int(T["earlierReserve"]), int(e["total"]) - int(e["claimedTotal"]))
    same("team.inVester", T["inVester"], num(block, tm, "balanceOf(address)(uint256)", v))
    same("team.promised", T["promised"], num(block, v, "committed()(uint256)"))
    same("team.ungranted leaves the reserve out", int(T["ungranted"]), int(T["inVester"]) - int(T["promised"]) - int(T["earlierReserve"]))
    same("the claimed grants are protected and listed", sorted(g["kind"] for g in T["grants"]), ["protected"] * int(e["claimedRows"]))
    for g in T["grants"]:
        member, protected, state, *_ = cast(block, v, "grantOf(uint256)(address,bool,uint8,uint64,uint256,uint256,uint256,uint256)", g["id"])
        same(f"grant {g['id']} is protected", protected, "true")
        same(f"grant {g['id']} is for the account that claimed", g["member"], member.lower())
    # The holdings: a parked Share is its owner's; the pause contract holds no one's Shares.
    for h in r["holders"]:
        owned = num(block, sh, "balanceOf(address)(uint256)", h["account"]) + num(block, pause, "parkedOf(address)(uint256)", h["account"])
        same(f"holding of {h['account'][:8]} is its balance and what it parked", h["shares"], owned)
    same("the pause contract is no holder", any(h["account"] == pause for h in r["holders"]), False)
    donated = num(block, sh, "balanceOf(address)(uint256)", pause) - num(block, pause, "parkedTotal()(uint256)")
    same("the holdings add up to the supply less what was sent to the pause by a plain transfer",
         sum(int(h["shares"]) for h in r["holders"]), num(block, sh, "totalSupply()(uint256)") - donated)
    same("no list was cut", r["truncated"], False)


def check_council(r, block, now, played):
    """The third example against the contracts: the Council runner, every number of the vote rule, the open ballot's
    fields and its derived result, and no voter row."""
    c = played["projects"]["C"]
    t, sh, tm, v, pause = c["treasury"], c["shares"], c["team"], c["vester"], c["pause"]
    council = c["council"]
    same("the example block", block, played["books"]["C_waiting"]["block"])
    same("asOf.time", now, int(fx.rpc("eth_getBlockByNumber", hex(block), False)["timestamp"], 16))
    same("project key", r["key"], c["key"])
    for name in ("treasury", "shares", "team", "vester"):
        same(f"contracts.{name}", r["contracts"][name], c[name])
    same("contracts.pause is the Treasury's pauseGate()", r["contracts"]["pause"], pause)
    # The runner.
    same("runner.address is the Treasury's runner()", r["runner"]["address"], lower(cast(block, t, "runner()(address)")[0]))
    same("runner.kind is council", r["runner"]["kind"], "council")
    same("runner.isPair is false", r["runner"]["isPair"], False)
    same("runner.signers is null", r["runner"]["signers"], None)
    seats = [lower(cast(block, council, "seatOf(uint8)(address,uint64,uint64)", i)[0]) for i in range(5)]
    same("council.contract is the Treasury's runner()", r["council"]["contract"], council)
    same("runner.seats is the live seats", r["runner"]["seats"], sum(1 for a in seats if a != ZERO))
    for i, seat in enumerate(r["council"]["seats"]):
        same(f"council.seats[{i}].account", seat["account"], None if seats[i] == ZERO else seats[i])
        same(f"council.seats[{i}].seatedAt", seat["seatedAt"],
             None if seats[i] == ZERO else int(cast(block, council, "seatOf(uint8)(address,uint64,uint64)", i)[1]))
    same("council.needed", r["council"]["needed"], num(block, council, "THRESHOLD()(uint8)"))
    same("council.generation", r["council"]["generation"], num(block, council, "generation()(uint32)"))
    same("council.nextElection", r["council"]["nextElection"], num(block, council, "nextElection()(uint64)"))
    same("council.upSeats", r["council"]["upSeats"], [int(x) for x in cast(block, council, "upNext()(uint8,uint8)")])
    same("council.waiting.count (no proposal was made)", r["council"]["waiting"]["count"], 0)
    same("council.waiting.kinds", r["council"]["waiting"]["kinds"], [])
    # The rule: every number from the contract's constants and views.
    rule, vote = r["vote"]["rule"], r["vote"]
    unit = r["unit"]
    day = num(block, pause, "day()(uint32)")
    same("vote.contract is the pause", vote["contract"], pause)
    same("vote.rule.standSecs is STAND_DAYS days", rule["standSecs"], num(block, pause, "STAND_DAYS()(uint256)") * day)
    same("vote.rule.voteSecs is VOTE_DAYS days", rule["voteSecs"], num(block, pause, "VOTE_DAYS()(uint256)") * day)
    same("vote.rule.waitSecs is the Treasury's noticeFor(500)", rule["waitSecs"], num(block, t, "noticeFor(uint16)(uint256,uint256,uint256)", 500))
    same("vote.rule.floorDivisor is LINE_DIVISOR", rule["floorDivisor"], num(block, pause, "LINE_DIVISOR()(uint256)"))
    same("vote.rule.openDivisor is OPEN_DIVISOR", rule["openDivisor"], num(block, pause, "OPEN_DIVISOR()(uint256)"))
    same("vote.rule.standDivisor is STAND_DIVISOR", rule["standDivisor"], num(block, pause, "STAND_DIVISOR()(uint256)"))
    same("vote.rule.cooldownSecs is COOLDOWN_UNITS units", rule["cooldownSecs"], num(block, pause, "COOLDOWN_UNITS()(uint256)") * unit)
    same("vote.rule.seatsEverySecs is ELECTION_UNITS units", rule["seatsEverySecs"], num(block, council, "ELECTION_UNITS()(uint256)") * unit)
    same("vote.rule.proposalTtlSecs is PROPOSAL_UNITS units", rule["proposalTtlSecs"], num(block, council, "PROPOSAL_UNITS()(uint256)") * unit)
    same("vote.rule.needed is the Council's THRESHOLD", rule["needed"], num(block, council, "THRESHOLD()(uint8)"))
    same("vote.rule.seats is the Council's SEATS", rule["seats"], num(block, council, "SEATS()(uint8)"))
    same("vote.rule.maxLists", rule["maxLists"], num(block, pause, "MAX_LISTS()(uint8)"))
    same("vote.rule.maxPeople", rule["maxPeople"], num(block, pause, "MAX_PEOPLE()(uint8)"))
    same("vote.rule.minVote", int(rule["minVote"]), num(block, pause, "MIN_VOTE()(uint256)"))
    # The next ballots.
    same("vote.next.replaceFrom", vote["next"]["replaceFrom"],
         max(num(block, pause, "nextReplaceAt()(uint64)"), now))
    same("vote.next.seatsAt is the Council's nextElection", vote["next"]["seatsAt"], num(block, council, "nextElection()(uint64)"))
    supply_now = num(block, sh, "totalSupply()(uint256)")
    same("vote.next.openFloor is a twentieth of the Shares, rounded up", int(vote["next"]["openFloor"]),
         -(-supply_now // num(block, pause, "OPEN_DIVISOR()(uint256)")))
    # The open ballot: fields from `ballot(id)`, tallies from `optionOf`, the result derived here.
    o = vote["open"]
    ballot_id = num(block, pause, "current()(uint32)")
    same("vote.open.id is the current ballot", o["id"], ballot_id)
    w = [int(x, 16) for x in fx.words(fx.eth_call(pause, "ballot(uint32)", ballot_id, block=str(block)))]
    names = ["kind", "outcome", "finished", "carried", "lapsed", "upA", "upB", "winner", "winnerB", "optionCount",
             "openedAt", "standEnd", "voteEnd", "effectiveAt", "supply", "floor", "council"]
    b = dict(zip(names, w))
    same("vote.open.kind", o["kind"], "seats" if b["kind"] == 2 else "replace")
    for field in ("openedAt", "standEnd", "voteEnd", "effectiveAt"):
        same(f"vote.open.{field}", o[field], b[field])
    same("vote.open.supply", int(o["supply"]), b["supply"])
    same("vote.open.floor", int(o["floor"]), b["floor"])
    same("vote.open.cast", int(o["cast"]), num(block, pause, "castOf(uint32)(uint256)", ballot_id))
    same("vote.open.carriedOutAt", o["carriedOutAt"], None)
    tally = []
    for i in range(b["optionCount"]):
        option_words = fx.words(fx.eth_call(pause, "optionOf(uint32,uint8)", ballot_id, i, block=str(block)))
        tally.append(int(option_words[8], 16))
        same(f"option {i} tally", int(o["options"][i]["tally"]), tally[-1])
    same("the tallies add up to the cast", sum(tally), int(o["cast"]))
    # The result, derived exactly as section 2.6, independently of the server's code.
    cast_total, floor, kind = int(o["cast"]), int(o["floor"]), b["kind"]
    if cast_total < floor:
        outcome, winners = "short", []
    elif kind == 1:
        win = [i for i in range(1, len(tally)) if tally[i] * 2 > cast_total]
        outcome, winners = ("moved", [win[0]]) if win else ("kept", [])
    else:
        keep_tally = tally[0]
        ranked = sorted(((tally[i], i) for i in range(1, len(tally))
                         if tally[i] >= int(rule["minVote"]) and tally[i] > keep_tally), reverse=True)
        if not ranked:
            outcome, winners = "unchanged", []
        elif len(ranked) > 1 and ranked[1][0] < ranked[0][0]:
            outcome, winners = "seated", [ranked[0][1], ranked[1][1]]
        else:
            outcome, winners = "seated", [ranked[0][1]]
    same("the example has a result to read", o["result"] is not None, True)
    if o["result"] is not None:
        same("vote.open.result.outcome is the frozen tallies' result", o["result"]["outcome"], outcome)
        same("vote.open.result.winners is the frozen tallies' result", o["result"]["winners"], winners)
        same("vote.open.result.recorded (nobody pressed finish on this ballot)", o["result"]["recorded"], False)
    same("the example is after voteEnd, in phase waiting", o["phase"], "waiting")
    # No voter row: no voter's address in the vote block, and no per-voter amount.
    voters = [played["accounts"][f"account{i}"] for i in (0, 1, 2, 3, 5, 9)]
    allowed = {pause, t} | set(seats)
    for option in o["options"]:
        allowed |= set(option["members"])
        if option["proposer"]:
            allowed.add(option["proposer"])
    text = json.dumps(vote)
    same("no voter address in the vote block", [a for a in voters if a in text and a not in allowed], [])
    # The winner unparked after the vote ended: the tallies stayed above what is parked now, and the record still shows
    # the planned change (COUNCIL-PLAN.md section 5.2).
    same("the cast is more than what is parked now",
         int(o["cast"]) > num(block, pause, "parkedTotal()(uint256)"), True)
    # Established: a Council of five counts as more than one account.
    same("established.twoSigners holds for a Council of five", r["established"]["twoSigners"], True)


def check_social(r, block, now, played):
    """The four social keys, recomputed from the run's raw logs by scripts/chain-social-recompute.py."""
    a = played["projects"]["A"]
    t, shares_token = a["treasury"], a["shares"]
    times = {b["number"]: b["time"] for b in played["blocks"]}
    raw = [{"block": l["block"], "index": l["index"], "address": l["address"], "topics": l["topics"], "data": l["data"]} for l in played["logs"]]
    logs = social.decode(raw, times, {a["treasury"], a["tasks"], a["shares"]}, block)
    # Nobody holds for the zero address, the project's contracts, the dollar and the Launcher.
    excluded = {social.ZERO, a["treasury"], a["vester"], a["shares"], a["team"], played["dollar"], played["launcher"]}
    balance = lambda account: num(block, shares_token, "balanceOf(address)(uint256)", account)
    ctx = {
        "treasury": t, "shares": shares_token, "excluded": excluded, "candidates": list(played["accounts"].values()),
        "balance": balance, "supply": num(block, shares_token, "totalSupply()(uint256)"),
        "in_excluded": sum(balance(e) for e in excluded if e != social.ZERO),
        "leave": num(block, t, "leaveValue()(uint256)"), "min_join": num(block, t, "MIN_JOIN()(uint256)"),
    }
    rank, badge = social.check_social(r, logs, now, ctx, same)
    same("the two windows give different figures in this run (a dip older than the rank window)", rank != badge, True)


if __name__ == "__main__":
    main()
