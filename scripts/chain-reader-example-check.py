#!/usr/bin/env python3
"""Checks the example record against the contracts, field by field, with `cast call` at the record's own block.

    python3 -I scripts/chain-reader-example-check.py [record.json]

It plays the same run the chain reader's fixture is made from (scripts/chain-reader-fixture.py, on a fresh anvil: the chain's clock is
fixed, so the same run gives the same blocks and addresses), keeps the chain, and then asks the contracts again, with `cast call --block`,
for everything the example record (docs/next-version/record-v2-example.json) says at `asOf.block`: every field of every task row, every
listed holder's note and claim, the buckets, the cap, the limits, the stream and the contracts' settled views. It reads nothing the
server wrote except the example file itself, and none of the fixture's recorded answers: the numbers it compares with are asked of the
chain by `cast` here. It prints one line per group and the number of checks, and exits non-zero on any difference.

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

EXAMPLE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(fx.REPO, "docs", "next-version", "record-v2-example.json")
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


if __name__ == "__main__":
    main()
