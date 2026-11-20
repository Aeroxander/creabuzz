#!/usr/bin/env python3
"""Checks the example record against the contracts, field by field, with `cast call` at the record's own block.

    python3 -I scripts/chain-reader-example-check.py [record.json]

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


# The event signatures the social keys read, hashed here (not taken from the server's table).
SIG = {
    "Transfer": "Transfer(address,address,uint256)",
    "Joined": "Joined(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
    "Left": "Left(address,address,uint256,uint256,uint256,uint256,uint256,uint256)",
    "TeamLeft": "TeamLeft(address,address,uint256,uint256,uint256,uint256,uint256)",
    "CheckedIn": "CheckedIn(address,bytes32,uint64)",
    "TaskAnnounced": "TaskAnnounced(uint64,bytes32,address,uint256,uint16,uint64,uint64,uint64,uint8)",
    "TaskTaken": "TaskTaken(uint64,address,uint256,uint256,uint64,uint64,uint256,uint8)",
    "TaskResolved": "TaskResolved(uint64,uint8,uint256,uint256,uint256,uint256,uint256,uint8,uint256)",
}


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
    start = checks
    check_social(r, block, now, played)
    print(f"the four social keys, recomputed from the raw logs: {checks - start} checks")


def decode_logs(played, block):
    """Project A's logs up to `block` as (time, block, index, name, address, topics, words), decoded by position."""
    topic0 = {fx.run(["cast", "keccak", sig]).lower(): name for name, sig in SIG.items()}
    times = {b["number"]: b["time"] for b in played["blocks"]}
    a = played["projects"]["A"]
    mine = {a["treasury"], a["tasks"], a["shares"]}
    out = []
    for l in played["logs"]:
        if l["block"] > block or l["address"] not in mine:
            continue
        name = topic0.get(l["topics"][0].lower())
        if name is None:
            continue
        data = l["data"][2:]
        words = [int(data[i : i + 64], 16) for i in range(0, len(data), 64)]
        out.append((times[l["block"]], l["block"], l["index"], name, l["address"], l["topics"], words))
    out.sort(key=lambda e: (e[1], e[2]))
    return out


def check_social(r, block, now, played):
    a = played["projects"]["A"]
    unit, launched = r["unit"], r["launchedAt"]
    logs = decode_logs(played, block)
    t, shares_token = a["treasury"], a["shares"]
    zero = "0x" + "00" * 20

    # ---- held: each account's lowest balance over a window, counted by walking its own balances through time.
    leave = num(block, t, "leaveValue()(uint256)")
    min_join = num(block, t, "MIN_JOIN()(uint256)")
    supply = num(block, shares_token, "totalSupply()(uint256)")
    # Nobody holds for the zero address, the project's contracts, the dollar and the Launcher.
    excluded = {zero, a["treasury"], a["vester"], a["shares"], a["team"], played["dollar"], played["launcher"]}
    moves = {}
    for time, blk, idx, name, addr, topics, words in logs:
        if name != "Transfer" or addr != shares_token:
            continue
        frm, to = "0x" + topics[1][-40:], "0x" + topics[2][-40:]
        if frm == to:
            continue
        if frm != zero:
            moves.setdefault(frm, []).append((blk, idx, time, -words[0]))
        if to != zero:
            moves.setdefault(to, []).append((blk, idx, time, words[0]))
    holders = {}
    for account in set(moves) | set(played["accounts"].values()):
        balance = num(block, shares_token, "balanceOf(address)(uint256)", account)
        if balance and account not in excluded:
            holders[account] = balance
    in_excluded = sum(
        num(block, shares_token, "balanceOf(address)(uint256)", e) for e in excluded if e != zero
    )
    same("held: the holders' balances add up to the supply less what the excluded accounts hold", sum(holders.values()), supply - in_excluded)

    def lowest(window):
        start = now - window
        out = {}
        for account, balance in holders.items():
            history = sorted(moves.get(account, []))
            at_start = sum(d for _, _, tm, d in history if tm <= start)
            low = running = at_start
            for _, _, tm, d in history:
                if tm > start:
                    running += d
                    low = min(low, running)
            same(f"held: the walk of {account[:8]} ends at its balance", running, balance)
            out[account] = low
        return out

    rank_secs, badge_secs = 30 * (unit // 7), 13 * unit
    H = r["held"]
    same("held.windows.rankSecs", H["windows"]["rankSecs"], rank_secs)
    same("held.windows.badgeSecs", H["windows"]["badgeSecs"], badge_secs)
    lows = lowest(rank_secs)
    rank_shares = sum(lows.values())
    same("held.rank.shares", H["rank"]["shares"], str(rank_shares))
    same("held.rank.bps", H["rank"]["bps"], 10_000 * rank_shares // supply)
    same("held.rank.money", H["rank"]["money"], str(rank_shares * leave // 10**18))
    same("held.rank.accounts", H["rank"]["accounts"], sum(1 for v in lows.values() if v * leave // 10**18 >= min_join))
    badge_shares = sum(lowest(badge_secs).values())
    same("held.badge.shares", H["badge"]["shares"], str(badge_shares))
    same("held.badge.bps", H["badge"]["bps"], 10_000 * badge_shares // supply)
    counted = sum(1 for v in holders.values() if v * leave // 10**18 >= min_join)
    same("held.countedAccounts", H["countedAccounts"], counted)
    same("the two windows give different figures in this run (a dip older than the rank window)", rank_shares != badge_shares, True)

    # ---- established
    E = r["established"]
    signers = r["runner"]["signers"]
    two = bool(r["runner"]["isPair"] and signers and signers[0] != signers[1] and zero not in signers)
    same("established.rule", E["rule"], {"minHeldBps": 6000, "heldSecs": badge_secs, "minAccounts": 10})
    same("established.heldBps", E["heldBps"], 10_000 * badge_shares // supply)
    same("established.accounts", E["accounts"], counted)
    same("established.twoSigners", E["twoSigners"], two)
    same("established.reached", E["reached"], 10_000 * badge_shares // supply >= 6000 and counted >= 10 and two)

    # ---- feed
    F = r["feed"]
    bucket = unit // 168
    first = now - now % bucket - 47 * bucket
    same("feed.bucketSecs", F["bucketSecs"], bucket)
    same("feed.roundTo", F["roundTo"], str(100 * 10**6))
    same("feed has 48 hours", len(F["hours"]), 48)
    for k, hour in enumerate(F["hours"]):
        lo = first + k * bucket
        joins = took = up = down = 0
        for time, blk, idx, name, addr, topics, words in logs:
            if addr != t or not (lo <= time < lo + bucket):
                continue
            if name == "Joined":
                joins += 1
                up += words[0] - words[1]
            elif name in ("Left", "TeamLeft"):
                took += 1
                down += words[1]
        rounded = (abs(up - down) + 50 * 10**6) // (100 * 10**6) * (100 * 10**6)
        want = {"dir": "even" if rounded == 0 else ("in" if up > down else "out"), "amount": str(rounded)}
        same(f"feed hour {k} at", hour["at"], lo)
        same(f"feed hour {k} joins", hour["joins"], joins)
        same(f"feed hour {k} tookOut", hour["tookOut"], took)
        same(f"feed hour {k} net", hour["net"], want)
    window = 28 * (unit // 7)
    items = []
    for time, blk, idx, name, addr, topics, words in reversed(logs):
        if time + window <= now:
            continue
        serial = int(topics[1], 16) if name.startswith("Task") else None
        if name == "CheckedIn" and addr == t:
            items.append({"kind": "update", "at": time, "serial": None, "date": None})
        elif name == "TaskAnnounced":
            items.append({"kind": "task_planned", "at": time, "serial": serial, "date": words[5]})
        elif name == "TaskTaken":
            items.append({"kind": "task_taken", "at": time, "serial": serial, "date": words[4]})
        elif name == "TaskResolved":
            kind = {3: "task_paid", 6: "task_withdrawn"}.get(words[0], "task_ended")
            items.append({"kind": kind, "at": time, "serial": serial, "date": None})
    same("feed.items", F["items"], items[:30])
    same("feed.cut", F["cut"], max(0, len(items) - 30))

    # ---- streaks: windows aligned to the launch
    checkins = sorted(time for time, blk, idx, name, addr, topics, words in logs if name == "CheckedIn" and addr == t)
    windows = {(tm - launched) // unit for tm in checkins}
    current = (now - launched) // unit
    weeks, k = 0, current if current in windows else current - 1
    while k >= 0 and k in windows:
        weeks += 1
        k -= 1
    longest = run = 0
    prev = None
    for w in sorted(windows):
        run = run + 1 if prev is not None and prev + 1 == w else 1
        longest = max(longest, run)
        prev = w
    S = r["streaks"]["updates"]
    same("streaks.updates.weeks", S["weeks"], weeks)
    same("streaks.updates.longest", S["longest"], longest)
    same("streaks.updates.lastAt", S["lastAt"], checkins[-1] if checkins else None)


if __name__ == "__main__":
    main()
