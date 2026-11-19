#!/usr/bin/env python3
"""Proves two things by breaking the contracts on purpose, one change at a time, in a scratch copy:

  vectors     a changed FORMULA makes `test/ModelVectors.t.sol` fail (the contracts are bound to the reference model);
  invariants  a removed or changed GUARD makes `test/PotInvariants.t.sol` or `test/MustBind.t.sol` fail (the invariant run
              and the handler would catch it).

Each mutation is an exact one-line text replacement that must occur exactly once. A mutation that leaves its tests green is a
hole in the tests: the script prints it and exits 1. The real project is never touched: a minimal copy goes to a temporary folder
(`lib` is linked, not copied).

Run from anywhere:   python3 contracts/pot/scripts/check-mutations.py [--only NAME] [--wait CMD] [--keep]
  --only NAME   run one mutation (or several, comma separated)
  --wait CMD    a shell command to run before every forge call (for machines shared with other builds)
  --keep        keep the scratch folder and print its path

Needs forge on PATH and about 30 seconds per mutation (the first compile is the slowest).
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
POT = os.path.dirname(HERE)

# (name, file, old text, new text, tests, what the change breaks)
V = "test/ModelVectors.t.sol"
QO = "test/QuoteOffset.t.sol"
SF = "test/SettleFirst.t.sol"
EX = "test/Expiry.t.sol"
INV = "test/PotInvariants.t.sol"
MB = "test/MustBind.t.sol"
MUTATIONS = [
    # ---- formulas: the vectors must notice
    ("offset-dollar", "src/PotMath.sol", "OFFSET_USD = 1;", "OFFSET_USD = 1e6;", QO, "the virtual money in the quote grows to a dollar"),
    ("offset-shares", "src/PotMath.sol", "OFFSET_SHARES = 1e14;", "OFFSET_SHARES = 100e18;", QO, "the virtual Shares in the quote grow to 100 Shares (a joiner buys below leave-value)"),
    ("quote-team", "src/PotMath.sol", "num = mn * (bq + ge) + sur * bq;", "num = mn * bq + sur * bq;", V, "the surplus shared with Team Shares in the price"),
    ("cash-team", "src/PotMath.sol", "return Math.mulDiv(n, a1, b) + Math.mulDiv(n, s, b + g);", "return Math.mulDiv(n, a1, b) + Math.mulDiv(n, s, b);", V, "the surplus shared with Team Shares in a take-out"),
    ("teamcash", "src/PotMath.sol", "        return Math.mulDiv(n, s, b + g);\n    }\n\n    /// @notice What leaves paid-in", "        return Math.mulDiv(n, s, b);\n    }\n\n    /// @notice What leaves paid-in", V, "a Team take-out"),
    ("paid-in-cut", "src/PotMath.sol", "return Math.mulDiv(paidIn, n, b);", "return Math.mulDiv(paidIn, n, b) / 2;", V, "what leaves paid-in on a take-out"),
    ("fee", "src/PotMath.sol", "return (a * feeBps + BPS - 1) / BPS;", "return (a * (feeBps + 1) + BPS - 1) / BPS;", V, "the platform fee"),
    ("credit", "src/PotMath.sol", "uint256 cap = Math.mulDiv(n, paidIn, b);", "uint256 cap = Math.mulDiv(n, paidIn, b) / 2;", V, "paid-in credited on a join"),
    ("accrual", "src/Treasury.sol", "Math.mulDiv(s.pot, rate * s.dt, PPM * (unit / 7))", "Math.mulDiv(s.pot, rate * s.dt, PPM * (unit / 8))", V, "the allowance accrual"),
    ("box-cap", "src/Treasury.sol", "uint256 cap = Math.mulDiv(s.pot + s.box, rate * 7, PPM);\n        if (s.dt", "uint256 cap = Math.mulDiv(s.pot + s.box, rate * 8, PPM);\n        if (s.dt", V, "the seven-day box cap"),
    ("release", "src/Treasury.sol", "Math.mulDiv(s.arriving, t - last, until - last)", "Math.mulDiv(s.arriving, t - last, until - last + 1000)", V, "the outside money release"),
    ("merge", "src/Treasury.sol", "Math.ceilDiv(old * rem + x * unit, old + x)", "Math.ceilDiv(x * unit, x)", V, "the weighted-average arrival of two payments"),
    ("window", "src/Treasury.sol", "CHECK_IN_MULT = 2;", "CHECK_IN_MULT = 3;", V, "the two-unit check-in window"),
    ("z-in-quote", "src/Treasury.sol", "uint256 ge = team.totalSupply() - Z;", "uint256 ge = team.totalSupply();", V, "the announced burn in the join price"),
    ("empty-credit", "src/PotMath.sol", "uint256 slice = Math.mulDiv(n, sur, b + OFFSET_SHARES + ge, Math.Rounding.Ceil);", "uint256 slice = 0;", V, "the slice a joiner pays for the surplus is not taken off its credit"),
    ("dust-credit", "src/PotMath.sol", "uint256 c = slice >= m ? 0 : m - slice;", "uint256 c = b == 0 ? (slice >= m ? 0 : m - slice) : m;", QO, "with backers in the project the credit ignores the surplus slice (a dust backer takes the Team's surplus)"),
    ("vesting", "src/Vester.sol", "VEST_MULT = 104;", "VEST_MULT = 52;", V, "the 104-unit vesting length"),
    # ---- guards: the invariant run and the must-bind tests must notice
    ("leave-cut", "src/Treasury.sol", "paidIn -= PotMath.paidInCut(paidIn, n, b);", "", INV, "paid-in is not cut on a take-out"),
    ("team-takes-paid-in", "src/Treasury.sol", "cash = PotMath.teamCash(n, pot, paidIn, shares.totalSupply(), g);", "cash = PotMath.cash(n, pot, paidIn, shares.totalSupply(), g);", INV, "Team Shares reach backers' paid-in money"),
    ("box-over-cap", "src/Treasury.sol", "if (s.box > cap) {", "if (s.box > cap && false) {", INV, "the box is not cut back to its cap"),
    ("fee-not-owed", "src/Treasury.sol", "feesOwed += fee;", "", INV, "the platform fee is not booked"),
    ("draw-keeps-box", "src/Treasury.sol", "        box -= amount;\n        _pay(to, amount);", "        _pay(to, amount);", INV, "a draw does not empty the box"),
    ("full-credit", "src/PotMath.sol", "return c;\n    }\n\n    /// @notice The cash `n` backer", "return m;\n    }\n\n    /// @notice The cash `n` backer", INV, "a join is credited its whole payment as paid-in"),
    ("late-settle-checkin", "src/Treasury.sol", "        _settle();\n        lastCheckIn = uint64(block.timestamp);", "        lastCheckIn = uint64(block.timestamp);\n        _settle();", MB, "a check-in that writes the window before it settles"),
    ("no-owner", "src/Treasury.sol", "if (shares.totalSupply() == 0 && team.totalSupply() == 0) revert NoOwner();", "", QO, "outside money accepted while nobody owns any Share"),
    ("revenue-cap", "src/Treasury.sol", "if (amount > MAX_REVENUE) revert TooMuch(amount, MAX_REVENUE);", "", "test/Revenue.t.sol", "an absurd outside payment wedges every join"),
    ("settle-leave", "src/Treasury.sol", "returns (uint256 cash) {\n        _settle();\n        uint256 b = shares.totalSupply();", "returns (uint256 cash) {\n        uint256 b = shares.totalSupply();", SF, "a take-out that does not settle first"),
    ("settle-leave-team", "src/Treasury.sol", "returns (uint256 cash) {\n        _settle();\n        uint256 g = team.totalSupply();", "returns (uint256 cash) {\n        uint256 g = team.totalSupply();", SF, "a Team take-out that does not settle first"),
    ("settle-pay-and-call", "src/Treasury.sol", "        _settle();\n        _gate(value);", "        _gate(value);", SF, "the one-signature join does not settle first"),
    ("settle-revenue", "src/Treasury.sol", "        _settle();\n        uint256 x = _pull(amount);", "        uint256 x = _pull(amount);", SF, "outside money merged into the stream without settling first"),
    ("pair-ttl", "src/Pair.sol", "if (block.timestamp > proposedAt[id] + PROPOSAL_TTL) revert Expired();", "", EX, "a Pair proposal never expires"),
    ("seat-expiry", "src/Treasury.sol", "if (block.timestamp > uint256(pendingSeatAt) + SEAT_OFFER_MULT * unit) revert OfferExpired();", "", EX, "a seat offer never expires"),
    ("seat-withdraw", "src/Treasury.sol", "if (next == runner) revert BadInput();", "if (next == runner || next == address(0)) revert BadInput();", EX, "a seat offer cannot be withdrawn"),
    ("min-grant", "src/Vester.sol", "amount < MIN_GRANT", "amount == 0", EX, "dust grants can fill a member's grant slots"),
    ("admin-accept", "src/Launcher.sol", "if (msg.sender != pendingAdmin) revert NotAdmin();", "", "test/Launcher.t.sol", "anyone can take an admin seat that was offered to someone else"),
    ("data-length", "src/Treasury.sol", "|| data.length != 64) revert NotAllowed();", "|| data.length < 64) revert NotAllowed();", "test/Join.t.sol", "the one-signature join accepts data longer than it decodes"),
    ("cliff", "src/Vester.sol", "CLIFF_MULT = 13;", "CLIFF_MULT = 14;", "test/Vester.t.sol", "the 13-unit vesting cliff"),
    ("raise-wait", "src/Treasury.sol", "if (block.timestamp < uint256(proposedAt) + unit) revert NotYet(uint256(proposedAt) + unit);", "if (block.timestamp < uint256(proposedAt) + unit / 2) revert NotYet(uint256(proposedAt) + unit);", "test/Allowance.t.sol", "a rate raise waits half a time unit instead of one"),
    ("rate-ceiling", "src/Treasury.sol", "MAX_RATE_PPM = 2000;", "MAX_RATE_PPM = 2001;", "test/Allowance.t.sol", "the 0.20% a day ceiling"),
    ("burn-anyone", "src/ShareToken.sol", "function burnFor(address from, uint256 value) external {\n        if (msg.sender != controller) revert NotController();", "function burnFor(address from, uint256 value) external {", "test/ShareToken.t.sol", "anyone can burn another's Shares (the burn authority)"),
]


def run(cmd, cwd, env, wait):
    if wait:
        subprocess.run(wait, shell=True, cwd=cwd)
    return subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)


def main():
    args = sys.argv[1:]
    only = set()
    wait = None
    keep = False
    i = 0
    while i < len(args):
        if args[i] == "--only":
            only = set(args[i + 1].split(","))
            i += 2
        elif args[i] == "--wait":
            wait = args[i + 1]
            i += 2
        elif args[i] == "--keep":
            keep = True
            i += 1
        else:
            print(__doc__)
            return 2
    work = tempfile.mkdtemp(prefix="pot-mutations-")
    try:
        for d in ("src", "model"):
            shutil.copytree(os.path.join(POT, d), os.path.join(work, d))
        for f in ("foundry.toml", "remappings.txt"):
            shutil.copy(os.path.join(POT, f), work)
        os.symlink(os.path.realpath(os.path.join(POT, "lib")), os.path.join(work, "lib"))
        keep_tests = {"ModelVectors.t.sol"} | {os.path.basename(m[4]) for m in MUTATIONS}
        os.makedirs(os.path.join(work, "test"))
        for sub in ("helpers", "mocks"):
            shutil.copytree(os.path.join(POT, "test", sub), os.path.join(work, "test", sub))
        for name in keep_tests:
            shutil.copy(os.path.join(POT, "test", name), os.path.join(work, "test", name))
        env = dict(os.environ, FOUNDRY_INVARIANT_RUNS="64")
        first = run(["forge", "test", "--match-path", "test/ModelVectors.t.sol"], work, env, wait)
        if first.returncode != 0:
            print("the unchanged copy does not pass its own vector test:\n" + first.stdout[-3000:] + first.stderr[-2000:])
            return 2
        survivors = []
        ran = 0
        for name, rel, old, new, tests, what in MUTATIONS:
            if only and name not in only:
                continue
            path = os.path.join(work, rel)
            text = open(path).read()
            if text.count(old) != 1:
                print("%-22s MUTATION DOES NOT APPLY (%d matches in %s)" % (name, text.count(old), rel))
                survivors.append(name)
                continue
            open(path, "w").write(text.replace(old, new))
            try:
                r = run(["forge", "test", "--match-path", tests], work, env, wait)
            finally:
                open(path, "w").write(text)
            ran += 1
            compiled = "Compiler run failed" not in (r.stdout + r.stderr)
            killed = r.returncode != 0 and compiled
            print("%-22s %s  (%s: %s)" % (name, "KILLED" if killed else "SURVIVED", os.path.basename(tests), what))
            if not killed:
                survivors.append(name)
        print("\n%d mutations run, %d survived" % (ran, len(survivors)))
        if survivors:
            print("survivors: " + ", ".join(survivors))
        return 1 if survivors else 0
    finally:
        if keep:
            print("scratch folder kept: " + work)
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
