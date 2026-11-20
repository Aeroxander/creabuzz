#!/usr/bin/env python3
"""Regenerates the chain reader's fixture from a real run of the contracts/pot contracts.

    python3 -I scripts/chain-reader-fixture.py            # run anvil, play the run, rewrite the fixture
    python3 -I scripts/chain-reader-fixture.py --check    # play it again and fail if the file is not what it gives

Needs `anvil`, `cast` and `forge` (FOUNDRY_BIN, a folder holding them, or PATH) and a contracts/pot build. It uses the public
anvil development mnemonic only (the keys are derived at run time; none is written here), picks a free port, and stops anvil
when it ends. The chain's clock is fixed (every block is one second after the one before unless the run names a time), so
the same run gives the same file, byte for byte.

The run is two projects on one chain. Project A is played for 115 days and covers every event the reader follows:
a launch, a grant, a join in one transaction (transferAndCall) and in two (approve, join), a take-out, weekly check-ins,
draws from the allowance, outside money arriving, a rate raise and its application, a lowered rate, the door switch, an
agent (set, drawing, revoked), a member's own exit (announce, burn), the runner's exit of a grant, a Team Share claim and
take-out, fees collected, a seat offered, withdrawn, offered again and taken, a wind-down by choice and the burns after
it. Between day 20 and day 101 it also plays the task queue (step 2): a task announced and withdrawn, one taken and paid in
part with a leaver's note claimed by the leaver, an open task taken by a stranger and sent back (its note claimed for the
leaver by the stranger), one that runs out and is returned by someone else's take-out (its note left unclaimed), one whose take
window passes, the same task record announced twice, and three tasks still open at the example block (one in its notice, one
taken with a note outstanding, one announced again), which the wind-down then sweeps. Outside money arrives twice, the second
payment merging into the first stream. Project B is launched by another founder, takes the seat through a Pair (both signers, a call executed, a call
cancelled), has one backer and is wound down through the Launcher. Last, the platform settings are changed and the admin
seat is offered and taken.

Output: crates/buzz-relay/src/chain_reader/testdata/pot-run.json with
  - blocks     every header of the run (number, hash, parent, time)
  - logs       every log of the chain, as the node returned them
  - projects   the addresses each project's Launcher event names (what the reader must find on its own)
  - snapshots  per project, the stored numbers the contract views gave right after each block that changed them
  - books      per named block, the raw answers of every view the record builder calls (replayed by the record tests); the
               block `A_example` is the one the example record (docs/next-version/record-v2-example.json) is built at
  - final      the views at the last block: the settled views, every holder's balances, every grant, the agents
The Rust tests replay `logs` through the reader's own code and compare with `snapshots` and `final`.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
POT = os.path.join(REPO, "contracts", "pot")
OUT = os.path.join(REPO, "crates", "buzz-relay", "src", "chain_reader", "testdata", "pot-run.json")

if os.environ.get("FOUNDRY_BIN"):
    os.environ["PATH"] = os.environ["FOUNDRY_BIN"] + os.pathsep + os.environ["PATH"]
for tool in ("anvil", "cast", "forge"):
    if shutil.which(tool) is None:
        sys.exit(f"chain-reader-fixture: {tool} is not on PATH")

GENESIS = 1_795_000_000  # 2026-11-17 or so; the chain's clock starts here
DAY = 86_400
UNIT = 604_800
MNEMONIC = "test test test test test test test test test test test junk"


def run(args, **kw):
    done = subprocess.run(args, capture_output=True, text=True, **kw)
    if done.returncode != 0:
        sys.exit(f"command failed: {' '.join(args[:6])} ...\n{done.stderr.strip()[-600:]}")
    return done.stdout.strip()


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


PORT = free_port()
RPC = f"http://127.0.0.1:{PORT}"


def rpc(method, *params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": list(params)}).encode()
    req = urllib.request.Request(RPC, body, {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


KEYS = [run(["cast", "wallet", "private-key", "--mnemonic", MNEMONIC, "--mnemonic-index", str(i)]) for i in range(10)]
ADDR = [run(["cast", "wallet", "address", "--private-key", k]).lower() for k in KEYS]
DEPLOYER, FOUNDER_A, BACKER1, BACKER2, MEMBER1, PAYER, AGENT, MEMBER2, FOUNDER_B, SECOND_B = range(10)

_sigs = {}


def selector(sig):
    if sig not in _sigs:
        _sigs[sig] = run(["cast", "sig", sig])
    return _sigs[sig]


def word(v):
    if isinstance(v, str) and v.startswith("0x"):
        return v[2:].rjust(64, "0")
    return format(int(v), "064x")


def eth_call(to, sig, *args, block="latest"):
    data = selector(sig) + "".join(word(a) for a in args)
    return rpc("eth_call", {"to": to, "data": data}, block)


def words(result):
    body = result[2:]
    return [body[i : i + 64] for i in range(0, len(body), 64)]


def uint(result, i=0):
    return int(words(result)[i], 16)


def addr_of(result, i=0):
    return "0x" + words(result)[i][24:]


def cast_send(who, to, sig, *args, ts=None):
    if ts is not None:
        rpc("evm_setNextBlockTimestamp", ts)
    out = run(["cast", "send", "--rpc-url", RPC, "--private-key", KEYS[who], "--json", to, sig, *[str(a) for a in args]])
    receipt = json.loads(out)
    if receipt["status"] != "0x1":
        raise RuntimeError(f"reverted: {sig} {args}")
    return int(receipt["blockNumber"], 16)


# ---- state of the run

clock = {"t": GENESIS + 1000}
proj = {}  # name -> dict of addresses
snapshots = {"A": [], "B": []}
last_snapshot = {}

TREASURY_VIEWS = [
    ("pot", "uint"), ("paidIn", "uint"), ("box", "uint"), ("arriving", "uint"), ("arrivalEnd", "uint"),
    ("feesOwed", "uint"), ("ratePpm", "uint"), ("pendingRatePpm", "uint"), ("pendingAt", "uint"),
    ("lastSettle", "uint"), ("lastCheckIn", "uint"), ("activeSeconds", "uint"), ("Z", "uint"),
    ("windDownKind", "uint"), ("windDownAt", "uint"), ("doorFlag", "bool"), ("runner", "addr"),
    ("locked", "uint"), ("notesOwed", "uint"), ("arrivalStart", "uint"), ("arrivalTotal", "uint"), ("nextExpiry", "uint"),
]

# The order of the fields of `TaskBook.taskOf`, read from the build, never typed here.
with open(os.path.join(POT, "out", "TaskBook.sol", "TaskBook.json")) as _f:
    _abi = json.load(_f)["abi"]
TASK_FIELDS = [
    c["name"]
    for fn in _abi
    if fn.get("type") == "function" and fn["name"] == "taskOf"
    for c in fn["outputs"][0]["components"]
]
NOTE_MINTED = run(["cast", "keccak", "NoteMinted(uint64,address,uint256,uint256,uint256)"]).lower()
# The accounts a note can belong to in this run (a take-out writes one for whoever leaves).
NOTE_HOLDERS = lambda: [ADDR[BACKER1], ADDR[BACKER2], ADDR[PAYER], ADDR[FOUNDER_A]]


def view_value(kind, result):
    if kind == "uint":
        return str(uint(result))
    if kind == "bool":
        return uint(result) != 0
    return addr_of(result)


def snapshot(name, block):
    """The stored numbers of project `name` at `block`, from the contracts' own views."""
    p = proj[name]
    at = hex(block)
    views = {}
    for fn, kind in TREASURY_VIEWS:
        views[fn] = view_value(kind, eth_call(p["treasury"], f"{fn}()", block=at))
    views["sharesSupply"] = str(uint(eth_call(p["shares"], "totalSupply()", block=at)))
    views["teamSupply"] = str(uint(eth_call(p["team"], "totalSupply()", block=at)))
    views["grantCount"] = str(uint(eth_call(p["vester"], "grantCount()", block=at)))
    views["committed"] = str(uint(eth_call(p["vester"], "committed()", block=at)))
    # the task book: counts, the cap's window (it moves with the block's time) and every task's answer (the 17 words of `taskOf`, as the node gave them)
    book = p["tasks"]
    views["openCount"] = str(uint(eth_call(book, "openCount()", block=at)))
    views["nextSerial"] = str(uint(eth_call(book, "nextSerial()", block=at)))
    views["windowSumBps"] = str(uint(eth_call(book, "windowSumBps()", block=at)))
    next_serial = int(views["nextSerial"])
    views["tasks"] = {
        str(serial): eth_call(book, "taskOf(uint64)", serial, block=at)
        for serial in range(1, next_serial)
    }
    notes = {}
    for serial in range(1, next_serial):
        for holder in NOTE_HOLDERS():
            n = uint(eth_call(book, "noteOf(uint64,address)", serial, holder, block=at))
            if n:
                notes[f"{serial}:{holder}"] = str(n)
    views["notes"] = notes
    return views


def snap_all(block):
    for name in proj:
        views = snapshot(name, block)
        if last_snapshot.get(name) != views:
            snapshots[name].append({"block": block, "views": views})
            last_snapshot[name] = views


def tx(who, to, sig, *args, at=None, after=None):
    """Send one transaction at an exact time (`at`, or `after` seconds after the last one), then snapshot."""
    t = at if at is not None else clock["t"] + (after if after is not None else 60)
    clock["t"] = t
    block = cast_send(who, to, sig, *args, ts=t)
    snap_all(block)
    return block


def day(n):
    return GENESIS + 1000 + int(n * DAY)


# The views a record is built from (RECORD-V2 section 4.2), as the server asks for them. The server's list is
# `chain_reader/views.rs`; this one is its mirror, taken as raw calldata and answer so that a test can replay
# the server's calls against the real chain's answers. A call the server makes that is not here fails its test.
TREASURY_UINTS = [
    "pot", "paidIn", "box", "arriving", "arrivalEnd", "feesOwed", "locked", "notesOwed", "ratePpm", "pendingRatePpm",
    "pendingAt", "lastSettle", "lastCheckIn", "activeSeconds", "activeEnd", "activeNow", "windDownKind", "windDownAt",
    "Z", "unit", "feeBps", "boxCap", "leaveValue", "teamValue", "agentUsd", "agentTeam", "agentEpoch", "MIN_JOIN",
    "MIN_REVENUE", "MAX_RATE_PPM", "CHECK_IN_MULT", "WIND_MULT", "arrivalStart", "arrivalTotal", "nextExpiry",
    "doorFlag", "doorOpenNow", "runner",
]
BOOK_CONSTANTS = ["MAX_OPEN", "MAX_SHARE_BPS", "CAP_BPS", "MIN_TASK", "CAP_WINDOW_MULT"]
BOOK_COUNTS = ["openCount", "nextSerial", "windowSumBps", "takeRoomBps"]
VESTER_UINTS = [
    "grantCount", "committed", "CLIFF_MULT", "VEST_MULT", "MIN_GRANT", "MAX_GRANTS_PER_MEMBER", "PROTECTED_LENGTH",
]


def record_book(p, launcher, dollar, block, logs):
    """Every view the record builder calls, for project `p` at `block`: {"<to>:<calldata>": "<answer>"}.

    The task book is read whole: every serial's `taskOf`, and `noteOf` and `claimableNote` for every holder a `NoteMinted`
    log names up to `block`. The server asks for fewer (its cut chooses the rows and the holders); it never needs more.
    """
    at_b = hex(block)
    book = {}

    def get(to, sig, *args):
        data = selector(sig) + "".join(word(a) for a in args)
        book[f"{to}:{data}"] = eth_call(to, sig, *args, block=at_b)
        return book[f"{to}:{data}"]

    t, v = p["treasury"], p["vester"]
    for name in TREASURY_UINTS:
        get(t, f"{name}()")
    for name in VESTER_UINTS:
        get(v, f"{name}()")
    get(p["shares"], "totalSupply()")
    get(p["team"], "totalSupply()")
    get(p["team"], "balanceOf(address)", v)
    get(dollar, "balanceOf(address)", t)
    get(launcher, "testNetwork()")
    runner = addr_of(eth_call(t, "runner()", block=at_b))
    is_pair = uint(get(launcher, "isPair(address)", runner)) != 0
    if is_pair:
        get(runner, "first()")
        get(runner, "second()")
    for i in range(uint(eth_call(v, "grantCount()", block=at_b))):
        for sig in ("grantOf(uint256)", "vestedOf(uint256)", "claimable(uint256)"):
            get(v, sig, i)
    for a in ADDR:
        for sig in ("agents(address)", "agentEpochOf(address)", "agentUsdUsed(address)", "agentTeamUsed(address)"):
            get(t, sig, a)
    # step 2: the task book
    b = p["tasks"]
    block_time = int(rpc("eth_getBlockByNumber", at_b, False)["timestamp"], 16)
    get(t, "tasks()")
    for name in BOOK_COUNTS + BOOK_CONSTANTS:
        get(b, f"{name}()")
    get(b, "dueC(uint256)", block_time)
    get(b, "noticeFor(uint16)", 1)
    for serial in range(1, uint(eth_call(b, "nextSerial()", block=at_b))):
        get(b, "taskOf(uint64)", serial)
    pairs = set()
    for l in logs:
        if l["address"] == b and l["topics"][0] == NOTE_MINTED and l["block"] <= block:
            pairs.add((int(l["topics"][1], 16), "0x" + l["topics"][2][-40:]))
    for serial, holder in sorted(pairs):
        get(b, "noteOf(uint64,address)", serial, holder)
        get(b, "claimableNote(uint64,address)", serial, holder)
    return book


def main():
    check = "--check" in sys.argv
    tmp = tempfile.mkdtemp(prefix="chain-reader-fixture-")
    anvil = subprocess.Popen(
        ["anvil", "--port", str(PORT), "--silent", "--timestamp", str(GENESIS)],
        stdout=open(os.path.join(tmp, "anvil.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(100):
            try:
                rpc("eth_chainId")
                break
            except Exception:
                time.sleep(0.2)
        rpc("anvil_setBlockTimestampInterval", 1)
        result = play(tmp)
    finally:
        anvil.terminate()
        anvil.wait()
        shutil.rmtree(tmp, ignore_errors=True)
    text = json.dumps(result, indent=1, sort_keys=True) + "\n"
    if check:
        current = open(OUT).read() if os.path.exists(OUT) else ""
        if current != text:
            sys.exit("pot-run.json is not what a fresh run gives: run python3 -I scripts/chain-reader-fixture.py")
        print("pot-run.json is what a fresh run gives")
        return
    with open(OUT, "w") as f:
        f.write(text)
    print(f"wrote {OUT} ({len(text)} bytes, {len(result['logs'])} logs, {len(result['blocks'])} blocks)")


def play(tmp):
    # ---- deploy (the real deploy script)
    env = dict(os.environ, UNIT=str(UNIT))
    # `--slow` makes forge wait for each deploy transaction's receipt before it sends the next, so anvil mines each one
    # in a block of its own. Without it forge sends them together and anvil puts two or three into one block, depending
    # on timing: the run then has a different number of blocks and `--check` fails most runs.
    subprocess.run(
        ["forge", "script", "script/DeployPot.s.sol", "--rpc-url", RPC, "--broadcast", "--slow", "--private-key",
         KEYS[DEPLOYER]],
        cwd=POT, env=env, check=True, capture_output=True,
    )
    # Do not rely on the flag alone: the three deploy transactions (the dollar, the parts, the Launcher) must sit in
    # blocks 1, 2 and 3, one each, or the run is not the run the tests were written against.
    deploy_blocks = [len(rpc("eth_getBlockByNumber", hex(n), False)["transactions"]) for n in (1, 2, 3)]
    if int(rpc("eth_blockNumber"), 16) != 3 or deploy_blocks != [1, 1, 1]:
        sys.exit(f"chain-reader-fixture: the deploy did not make three blocks of one transaction each: {deploy_blocks}")
    with open(os.path.join(POT, "deployments", "pot-31337.json")) as f:
        dep = json.load(f)
    launcher, dollar = dep["launcher"].lower(), dep["quote"].lower()
    assert int(dep["unit"]) == UNIT

    def launch(who, name, project_id, rate, pool, at):
        h = run(["cast", "call", "--rpc-url", RPC, launcher, "settingsHash()(bytes32)"])
        pid = run(["cast", "format-bytes32-string", project_id])
        tx(who, launcher, "launch(bytes32,string,string,(uint32,uint256),bytes32)", pid, name, name[:4].upper(),
           f"({rate},{pool})", h, at=at)
        out = run(["cast", "call", "--rpc-url", RPC, launcher, "project(address,bytes32)((address,address,address,address,address,uint64))", ADDR[who], pid])
        f, shares, team, treasury, vester, _ = [x.split()[0].lower() for x in out.strip("()").split(",")]
        key = run(["cast", "call", "--rpc-url", RPC, launcher, "keyOf(address,bytes32)(bytes32)", ADDR[who], pid])
        launch_block = int(rpc("eth_blockNumber"), 16)
        proj[name_of(project_id)] = dict(
            founder=f, shares=shares, team=team, treasury=treasury, vester=vester, key=key.lower(), projectId=pid.lower(),
            launchBlock=launch_block, tasks=addr_of(eth_call(treasury, "tasks()")),
        )
        snap_all(launch_block)

    def name_of(project_id):
        return "A" if project_id == "alpha" else "B"

    POOL_A = 10_000_000 * 10**18
    # ---- project A, day 0
    launch(FOUNDER_A, "Alpha Project", "alpha", 1000, POOL_A, day(0))
    A = proj["A"]
    T, V = A["treasury"], A["vester"]
    tx(FOUNDER_A, T, "grantTeam(address,uint256)", ADDR[FOUNDER_A], 2_000_000 * 10**18, at=day(0.05))
    tx(BACKER1, dollar, "faucet()", at=day(0.1))
    tx(DEPLOYER, dollar, "mint(address,uint256)", ADDR[BACKER1], 10_000_000_000, after=60)
    data = run(["cast", "abi-encode", "f(uint256,address)", "0", ADDR[BACKER1]])
    tx(BACKER1, dollar, "transferAndCall(address,uint256,bytes)", T, 5_000_000_000, data, after=60)
    tx(BACKER2, dollar, "faucet()", at=day(1))
    tx(DEPLOYER, dollar, "mint(address,uint256)", ADDR[BACKER2], 3_000_000_000, after=60)
    tx(BACKER2, dollar, "approve(address,uint256)", T, 2_000_000_000, after=60)
    tx(BACKER2, T, "join(uint256,uint256,address)", 2_000_000_000, 0, ADDR[BACKER2], after=60)

    # ---- project B is launched on day 30 by another founder; handled in the timeline below
    timeline = []

    def at(d, fn):
        timeline.append((d, len(timeline), fn))

    def weekly(i):
        return lambda: tx(runner_of(), T, "checkIn(bytes32)", run(["cast", "keccak", f"record {i}"]), at=day(7 * i))

    state = {"runner": FOUNDER_A, "b": {}}
    marks = {}  # blocks the record books are taken at, by name

    def runner_of():
        return state["runner"]

    for i in range(1, 17):
        at(7 * i, weekly(i))
    at(14.5, lambda: tx(runner_of(), T, "draw(address,uint256)", ADDR[runner_of()], 30_000_000, at=day(14.5)))
    at(20, lambda: tx(runner_of(), T, "grantTeam(address,uint256)", ADDR[MEMBER1], 400_000 * 10**18, at=day(20)))
    at(25, lambda: tx(runner_of(), T, "grantTeam(address,uint256)", ADDR[MEMBER1], 300_000 * 10**18, at=day(25)))
    at(35.5, lambda: tx(runner_of(), T, "draw(address,uint256)", ADDR[runner_of()], 30_000_000, at=day(35.5)))

    def take_out_a_tenth():
        n = uint(eth_call(A["shares"], "balanceOf(address)", ADDR[BACKER2])) // 10
        tx(BACKER2, T, "leave(uint256,uint256,address)", n, 0, ADDR[BACKER2], at=day(60))

    at(60, take_out_a_tenth)
    at(70, lambda: tx(runner_of(), T, "grantTeam(address,uint256)", ADDR[MEMBER2], 100_000 * 10**18, at=day(70)))
    at(95, lambda: tx(PAYER, V, "claim(uint256)", 0, at=day(95)))

    def outside_money():
        tx(PAYER, dollar, "faucet()", at=day(98))
        tx(DEPLOYER, dollar, "mint(address,uint256)", ADDR[PAYER], 5_000_000_000, after=60)
        tx(PAYER, dollar, "approve(address,uint256)", T, 3_000_000_000, after=60)
        tx(PAYER, T, "addRevenue(uint256)", 3_000_000_000, after=60)


    # ---- the task queue (step 2) on project A, all at exact times on the real unit of 7 days
    W1, W2, STRANGER = MEMBER1, MEMBER2, PAYER  # two named workers and a stranger with no stake
    book = A["tasks"]
    what = lambda label: run(["cast", "keccak", f"task record {label}"])
    ZERO = "0x" + "00" * 20
    serials = {}

    def task(serial):
        """The fields of task `serial` now, by name (the order is the build's)."""
        w = words(eth_call(book, "taskOf(uint64)", serial))
        return {name: int(w[i], 16) for i, name in enumerate(TASK_FIELDS)}

    def announce(name, label, payee, share_bps, when, max_dollars=400_000_000):
        tx(runner_of(), T, "announceTask(bytes32,address,uint256,uint16)", what(label), payee, max_dollars, share_bps, at=when)
        serials[name] = uint(eth_call(book, "nextSerial()")) - 1

    def take(name, who, extra=1):
        """Take at the second after the notice ends."""
        tx(who, T, "takeTask(uint64,uint256)", serials[name], 0, at=task(serials[name])["noticeEnd"] + extra)

    def leave_part_block(who, parts, when):
        n = uint(eth_call(A["shares"], "balanceOf(address)", ADDR[who])) // parts
        return tx(who, T, "leave(uint256,uint256,address)", n, 0, ADDR[who], at=when)

    leave_part = leave_part_block

    at(20.2, lambda: announce("T1", "T1", ADDR[W1], 100, day(20.2)))
    at(20.4, lambda: tx(runner_of(), T, "cancelTask(uint64)", serials["T1"], at=day(20.4)))
    at(61, lambda: announce("T2", "T2", ADDR[W1], 200, day(61)))
    at(62, lambda: announce("T3", "T3", ZERO, 100, day(62)))
    at(68, lambda: announce("T4", "T4", ADDR[W2], 100, day(68)))
    at(70.5, lambda: announce("T5", "T5", ADDR[W2], 100, day(70.5)))
    at(76, lambda: take("T2", W1))
    at(76.5, lambda: take("T3", STRANGER))
    at(77.2, lambda: leave_part(BACKER1, 5, day(77.2)))
    at(78, lambda: tx(runner_of(), T, "rejectTask(uint64)", serials["T3"], at=day(78)))
    at(79, lambda: tx(STRANGER, T, "claimNote(uint64,address)", serials["T3"], ADDR[BACKER1], at=day(79)))
    at(80, lambda: tx(runner_of(), T, "acceptTask(uint64,uint256)", serials["T2"], task(serials["T2"])["locked"] * 6 // 10, at=day(80)))
    at(81.2, lambda: tx(BACKER1, T, "claimNote(uint64,address)", serials["T2"], ADDR[BACKER1], at=day(81.2)))
    at(82.5, lambda: take("T4", W2))
    at(83, lambda: leave_part(BACKER2, 4, day(83)))
    at(85, lambda: announce("T7", "T7", ADDR[W1], 100, day(85)))

    def third_holder_joins():
        tx(DEPLOYER, dollar, "mint(address,uint256)", ADDR[PAYER], 500_000_000, at=day(90))
        tx(PAYER, dollar, "approve(address,uint256)", T, 500_000_000, after=60)
        tx(PAYER, T, "join(uint256,uint256,address)", 500_000_000, 0, ADDR[PAYER], after=60)

    at(90, third_holder_joins)
    at(92.2, lambda: announce("T6", "T6", ADDR[W1], 100, day(92.2)))
    # the same task record planned a second time, left announced (the later row is a repeat of T2)
    at(93.2, lambda: announce("T8", "T2", ADDR[W1], 100, day(93.2)))

    # a task withdrawn inside the 28 days the example looks back over (the first, withdrawn on day 20, is older)
    at(94, lambda: announce("T9", "T9", ADDR[W2], 100, day(94)))
    at(94.3, lambda: tx(runner_of(), T, "cancelTask(uint64)", serials["T9"], at=day(94.3)))

    def third_holder_leaves():
        n = uint(eth_call(A["shares"], "balanceOf(address)", ADDR[PAYER]))
        tx(PAYER, T, "leave(uint256,uint256,address)", n, 0, ADDR[PAYER], at=day(97))

    # a block after T4's deadline that no Treasury call settles (the dollar's `approve`): the task has run out and is
    # still `taken` in the book, so the settled numbers must count it as returned
    at(96.8, lambda: marks.__setitem__("A_overdue", tx(PAYER, dollar, "approve(address,uint256)", T, 1, at=day(96.8))))
    at(97, third_holder_leaves)
    at(99.5, lambda: take("T7", W1))

    def second_outside_money():
        tx(PAYER, dollar, "approve(address,uint256)", T, 1_000_000_000, at=day(100.5))
        tx(PAYER, T, "addRevenue(uint256)", 1_000_000_000, after=60)

    at(100.5, second_outside_money)
    at(101.7, lambda: marks.__setitem__("A_example", leave_part_block(BACKER1, 10, day(101.7))))
    # a block inside the merged stream, a day after the last settle: no Treasury call settles it (the dollar's `approve`), so the
    # money that has arrived since is only in the formula, not in the stored numbers
    at(102.6, lambda: marks.__setitem__("A_stream", tx(PAYER, dollar, "approve(address,uint256)", T, 2, at=day(102.6))))

    at(98, outside_money)
    at(99, lambda: tx(MEMBER1, V, "announceForfeit(uint256)", 1, at=day(99)))
    at(100, lambda: tx(runner_of(), T, "proposeRate(uint32)", 1500, at=day(100)))
    at(101, lambda: tx(runner_of(), T, "setDoor(bool)", "false", at=day(101)))
    at(101.5, lambda: tx(runner_of(), T, "setDoor(bool)", "true", at=day(101.5)))
    at(102, lambda: tx(runner_of(), T, "authoriseAgent(address)", ADDR[AGENT], at=day(102)))
    at(102.2, lambda: tx(runner_of(), T, "setAgent(address,uint128,uint128)", ADDR[AGENT], 40_000_000, 100 * 10**18, at=day(102.2)))
    at(103, lambda: marks.__setitem__("A_live", tx(AGENT, T, "draw(address,uint256)", ADDR[AGENT], 5_000_000, at=day(103))))
    at(104, lambda: tx(runner_of(), T, "revokeAgent(address)", ADDR[AGENT], at=day(104)))
    at(106.5, lambda: tx(PAYER, V, "execute(uint256)", 1, at=day(106.5)))
    at(107.5, lambda: tx(PAYER, T, "applyRate()", at=day(107.5)))
    at(108.5, lambda: tx(runner_of(), T, "setRate(uint32)", 800, at=day(108.5)))
    at(109, lambda: tx(BACKER1, dollar, "approve(address,uint256)", T, 1_000_000_000, at=day(109)))
    at(109.1, lambda: tx(BACKER1, T, "join(uint256,uint256,address)", 1_000_000_000, 0, ADDR[BACKER1], at=day(109.1)))

    def founder_takes_out_team():
        n = uint(eth_call(A["team"], "balanceOf(address)", ADDR[FOUNDER_A])) // 2
        tx(FOUNDER_A, T, "leaveTeam(uint256,uint256,address)", n, 0, ADDR[FOUNDER_A], at=day(110))

    at(110, founder_takes_out_team)
    at(111, lambda: tx(PAYER, T, "collectFees()", at=day(111)))
    at(111.5, lambda: tx(PAYER, T, "settle()", at=day(111.5)))

    def seat_handover():
        tx(FOUNDER_A, T, "handOver(address,bool)", ADDR[MEMBER2], "false", at=day(112))
        tx(FOUNDER_A, T, "handOver(address,bool)", "0x0000000000000000000000000000000000000000", "false", after=60)
        tx(FOUNDER_A, T, "handOver(address,bool)", ADDR[MEMBER2], "false", after=60)
        tx(MEMBER2, T, "takeSeat()", after=60)
        state["runner"] = MEMBER2

    at(112, seat_handover)
    at(113, lambda: tx(runner_of(), T, "windDown()", at=day(113)))
    wind_end = 113 + 7.01
    at(wind_end, lambda: tx(PAYER, V, "burnAfterWindDown(uint256)", 3, at=day(wind_end)))
    at(wind_end + 0.05, lambda: tx(PAYER, V, "burnAfterWindDown(uint256)", 2, at=day(wind_end + 0.05)))
    at(wind_end + 0.1, lambda: tx(PAYER, V, "burnUngrantedAfterWindDown()", at=day(wind_end + 0.1)))

    def leave_all(who):
        def f():
            n = uint(eth_call(A["shares"], "balanceOf(address)", ADDR[who]))
            tx(who, T, "leave(uint256,uint256,address)", n, 0, ADDR[who], at=day(wind_end + 0.5 + who / 100))
        return f

    at(wind_end + 0.5, leave_all(BACKER1))
    at(wind_end + 1, lambda: tx(PAYER, T, "settle()", at=day(wind_end + 1)))

    # ---- project B (a Pair, a call executed, a call cancelled, a wind-down through the Launcher)
    def b_launch():
        launch(FOUNDER_B, "Beta Project", "beta", 500, 1_000_000 * 10**18, day(30))
        B = proj["B"]
        pair = run(["cast", "call", "--rpc-url", RPC, launcher, "pairAddress(bytes32,address,address)(address)", B["key"], ADDR[FOUNDER_B], ADDR[SECOND_B]]).lower()
        B["pair"] = pair
        tx(FOUNDER_B, B["treasury"], "handOver(address,bool)", pair, "false", after=60)
        tx(SECOND_B, launcher, "makePair(bytes32,address)", B["key"], ADDR[FOUNDER_B], after=60)
        tx(BACKER2, dollar, "approve(address,uint256)", B["treasury"], 100_000_000, after=60)
        tx(BACKER2, B["treasury"], "join(uint256,uint256,address)", 100_000_000, 0, ADDR[BACKER2], after=60)
        tx(SECOND_B, pair, "checkIn(bytes32)", run(["cast", "keccak", "record b1"]), after=60)

    at(30, b_launch)

    def pair_call(target, sig, *args, cancel=False, when):
        B = proj["B"]
        pair = B["pair"]
        calldata = run(["cast", "calldata", sig, *[str(a) for a in args]])
        nonce = uint(eth_call(pair, "nonce()"))
        tx(FOUNDER_B, pair, "propose(address,bytes)", target, calldata, at=day(when))
        if cancel:
            cid = run(["cast", "call", "--rpc-url", RPC, pair, "callId(address,bytes,uint256)(bytes32)", target, calldata, str(nonce)])
            tx(FOUNDER_B, pair, "cancel(bytes32)", cid, after=60)
        else:
            tx(SECOND_B, pair, "confirm(address,bytes,uint256)", target, calldata, nonce, after=60)

    at(31, lambda: pair_call(proj["B"]["treasury"], "grantTeam(address,uint256)", ADDR[MEMBER1], 100_000 * 10**18, when=31))
    at(34, lambda: pair_call(proj["B"]["treasury"], "announceForfeit(uint256)", 0, when=34))
    at(42, lambda: tx(PAYER, proj["B"]["vester"], "execute(uint256)", 0, at=day(42)))
    at(32, lambda: pair_call(proj["B"]["treasury"], "setDoor(bool)", "false", when=32))
    at(33, lambda: pair_call(proj["B"]["treasury"], "setDoor(bool)", "true", cancel=True, when=33))
    at(35, lambda: marks.__setitem__("B_pair", tx(SECOND_B, proj["B"]["pair"], "checkIn(bytes32)", run(["cast", "keccak", "record b2"]), at=day(35))))
    at(40, lambda: pair_call(launcher, "windDown(bytes32)", proj["B"]["key"], when=40))

    def admin():
        t = day(120)
        settings = run(["cast", "call", "--rpc-url", RPC, launcher, "platform()(address,address,uint16,uint32,uint128)"]).split("\n")
        tup = "(" + ",".join(x.split()[0] for x in settings) + ")"
        tx(DEPLOYER, launcher, "setSettings((address,address,uint16,uint32,uint128))", tup, at=t)
        tx(DEPLOYER, launcher, "transferAdmin(address)", ADDR[PAYER], after=60)
        tx(PAYER, launcher, "acceptAdmin()", after=60)

    at(120, admin)

    for _, _, fn in sorted(timeline, key=lambda e: (e[0], e[1])):
        fn()

    # ---- capture
    head = int(rpc("eth_blockNumber"), 16)
    blocks = []
    for n in range(head + 1):
        b = rpc("eth_getBlockByNumber", hex(n), False)
        blocks.append({"number": n, "hash": b["hash"], "parent": b["parentHash"], "time": int(b["timestamp"], 16)})
    raw = rpc("eth_getLogs", {"fromBlock": "0x0", "toBlock": hex(head)})
    logs = [
        {
            "block": int(l["blockNumber"], 16),
            "index": int(l["logIndex"], 16),
            "blockHash": l["blockHash"],
            "txHash": l["transactionHash"],
            "address": l["address"].lower(),
            "topics": l["topics"],
            "data": l["data"],
        }
        for l in raw
    ]
    logs.sort(key=lambda l: (l["block"], l["index"]))
    final_time = blocks[-1]["time"]
    accounts = {f"account{i}": a for i, a in enumerate(ADDR)}
    final = {"block": head, "time": final_time}
    for name, p in proj.items():
        at_b = hex(head)
        t, sh, tm, v = p["treasury"], p["shares"], p["team"], p["vester"]
        settled = {
            "boxCap": str(uint(eth_call(t, "boxCap()", block=at_b))),
            "activeNow": str(uint(eth_call(t, "activeNow()", block=at_b))),
            "activeEnd": str(uint(eth_call(t, "activeEnd()", block=at_b))),
            "leaveValue": str(uint(eth_call(t, "leaveValue()", block=at_b))),
            "teamValue": str(uint(eth_call(t, "teamValue()", block=at_b))),
            "doorOpenNow": uint(eth_call(t, "doorOpenNow()", block=at_b)) != 0,
            "unit": str(uint(eth_call(t, "unit()", block=at_b))),
            "feeBps": str(uint(eth_call(t, "feeBps()", block=at_b))),
        }
        holders = list(ADDR) + [t, v, p.get("pair", "0x" + "00" * 20)]
        balances = {"shares": {}, "team": {}}
        for h in holders:
            for tok, key in ((sh, "shares"), (tm, "team")):
                b = uint(eth_call(tok, "balanceOf(address)", h, block=at_b))
                if b:
                    balances[key][h] = str(b)
        grants = []
        for i in range(uint(eth_call(v, "grantCount()", block=at_b))):
            w = words(eth_call(v, "grantOf(uint256)", i, block=at_b))
            grants.append({
                "id": i, "member": "0x" + w[0][24:], "protected": int(w[1], 16) != 0, "state": int(w[2], 16),
                "burnAt": str(int(w[3], 16)), "total": str(int(w[4], 16)), "claimed": str(int(w[5], 16)),
                "start": str(int(w[6], 16)), "burn": str(int(w[7], 16)),
                "vested": str(uint(eth_call(v, "vestedOf(uint256)", i, block=at_b))),
                "claimable": str(uint(eth_call(v, "claimable(uint256)", i, block=at_b))),
            })
        agents = {}
        for a in (AGENT,):
            w = words(eth_call(t, "agents(address)", ADDR[a], block=at_b))
            agents[ADDR[a]] = {
                "active": int(w[0], 16) != 0, "usdCap": str(int(w[1], 16)), "shareCap": str(int(w[2], 16)),
                "epoch": str(uint(eth_call(t, "agentEpochOf(address)", ADDR[a], block=at_b))),
            }
        final[name] = {
            "views": snapshot(name, head), "settled": settled, "balances": balances, "grants": grants,
            "agents": agents, "agentEpoch": str(uint(eth_call(t, "agentEpoch()", block=at_b))),
            "dollarHeld": str(uint(eth_call(dollar, "balanceOf(address)", t, block=at_b))),
        }
    books = {}
    for name, project, block in (
        ("A_example", "A", marks["A_example"]),
        ("A_overdue", "A", marks["A_overdue"]),
        ("A_stream", "A", marks["A_stream"]),
        ("A_live", "A", marks["A_live"]),
        ("B_pair", "B", marks["B_pair"]),
        ("A_end", "A", head),
        ("B_end", "B", head),
    ):
        books[name] = {
            "project": project,
            "block": block,
            "calls": record_book(proj[project], launcher, dollar, block, logs),
        }
    return {
        "about": "A real run of contracts/pot on anvil, played by scripts/chain-reader-fixture.py. Do not edit by hand.",
        "chainId": 31337,
        "unit": UNIT,
        "launcher": launcher,
        "dollar": dollar,
        "accounts": accounts,
        "projects": proj,
        "blocks": blocks,
        "logs": logs,
        "snapshots": snapshots,
        "books": books,
        "final": final,
    }


if __name__ == "__main__":
    main()
