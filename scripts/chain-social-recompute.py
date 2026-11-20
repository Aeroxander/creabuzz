#!/usr/bin/env python3
"""An independent recomputation of the four social keys of a project numbers record (`held`, `feed`, `streaks`, `established`).

Not run by itself: `scripts/chain-reader-example-check.py` (the example record against the fixture's run) and
`scripts/chain-loop-pot-check.py` (the record a real relay signed against a live chain, at nine stops) load it with
importlib and call `check_social`. It shares no code with the Rust (`chain_reader/held.rs`, `record_social.rs`): the raw logs of a
project (topics and data, decoded here by position), the chain's own balances and per-Share figure, and the plan's rules
(docs/next-version/STEP3-PLAN.md section 2) are all it uses.

`logs` are tuples `(time, block, index, name, address, topics, words)` from `decode`; `ctx` says what the chain says (see
`check_social`); `same(what, record, chain)` is the caller's comparison (it records or raises on a difference).
"""

import subprocess

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
ZERO = "0x" + "00" * 20


def topic_names():
    """The event names by their topic, hashed here with `cast keccak`."""
    out = {}
    for name, sig in SIG.items():
        out[subprocess.run(["cast", "keccak", sig], capture_output=True, text=True, check=True).stdout.strip().lower()] = name
    return out


def decode(raw, times, mine, block):
    """Decode raw logs `{block, index, address, topics, data}` of the contracts in `mine`, up to `block`, by position."""
    names = topic_names()
    out = []
    for l in raw:
        if l["block"] > block or l["address"].lower() not in mine or not l["topics"]:
            continue
        name = names.get(l["topics"][0].lower())
        if name is None:
            continue
        data = l["data"][2:]
        words = [int(data[i : i + 64], 16) for i in range(0, len(data), 64)]
        out.append((times[l["block"]], l["block"], l["index"], name, l["address"].lower(), l["topics"], words))
    out.sort(key=lambda e: (e[1], e[2]))
    return out


def check_social(r, logs, now, ctx, same):
    """Compare the record's four social keys with what the raw logs and the chain say.

    `ctx`: treasury, shares (the token), excluded (accounts nobody holds for), candidates (accounts that may hold),
    balance(account), supply, in_excluded, leave (the per-Share figure), min_join.
    """
    unit, launched = r["unit"], r["launchedAt"]
    t, shares_token = ctx["treasury"], ctx["shares"]
    leave, min_join, supply = ctx["leave"], ctx["min_join"], ctx["supply"]

    # ---- held: each account's lowest balance over a window, counted by walking its own balances through time.
    moves = {}
    for time, blk, idx, name, addr, topics, words in logs:
        if name != "Transfer" or addr != shares_token:
            continue
        frm, to = "0x" + topics[1][-40:], "0x" + topics[2][-40:]
        if frm == to:
            continue
        if frm != ZERO:
            moves.setdefault(frm, []).append((blk, idx, time, -words[0]))
        if to != ZERO:
            moves.setdefault(to, []).append((blk, idx, time, words[0]))
    holders = {}
    for account in set(moves) | set(ctx["candidates"]):
        balance = ctx["balance"](account)
        if balance and account not in ctx["excluded"]:
            holders[account] = balance
    same("held: the holders' balances add up to the supply less what the excluded accounts hold", sum(holders.values()), supply - ctx["in_excluded"])

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
    same("held.rank.bps", H["rank"]["bps"], 10_000 * rank_shares // supply if supply else 0)
    same("held.rank.money", H["rank"]["money"], str(rank_shares * leave // 10**18))
    same("held.rank.accounts", H["rank"]["accounts"], sum(1 for v in lows.values() if v * leave // 10**18 >= min_join))
    badge_shares = sum(lowest(badge_secs).values())
    same("held.badge.shares", H["badge"]["shares"], str(badge_shares))
    badge_bps = 10_000 * badge_shares // supply if supply else 0
    same("held.badge.bps", H["badge"]["bps"], badge_bps)
    counted = sum(1 for v in holders.values() if v * leave // 10**18 >= min_join)
    same("held.countedAccounts", H["countedAccounts"], counted)

    # ---- established
    E = r["established"]
    signers = r["runner"]["signers"]
    two = bool(r["runner"]["isPair"] and signers and signers[0] != signers[1] and ZERO not in signers)
    same("established.rule", E["rule"], {"minHeldBps": 6000, "heldSecs": badge_secs, "minAccounts": 10})
    same("established.heldBps", E["heldBps"], badge_bps)
    same("established.accounts", E["accounts"], counted)
    same("established.twoSigners", E["twoSigners"], two)
    same("established.reached", E["reached"], badge_bps >= 6000 and counted >= 10 and two)

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
    return rank_shares, badge_shares
