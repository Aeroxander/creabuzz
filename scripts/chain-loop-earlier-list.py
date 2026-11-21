#!/usr/bin/env python3
"""A tiny INVENTED earlier-backers list for scripts/chain-loop-pot.sh (STEP4=1): two rows, built here, never written to a file.

    python3 -I scripts/chain-loop-earlier-list.py <account of row 0> <account of row 1>

Prints one JSON object on stdout: the Merkle root the claim contract is made with, the fingerprint of an invented text, the pool
(the sum of the rows, Team Share wei), the number of rows, and the proof of each row. The leaf is
keccak256(keccak256(abi.encode(index, account, amount))) and the two leaves are joined in sorted order, as the claim contract
checks (contracts/pot/src/EarlierGrants.sol). Needs `cast` on PATH. The rows are invented: the accounts are anvil's public ones and
the amounts are chosen here (1,000 and 2,500 Team Shares).
"""
import json
import subprocess
import sys


def keccak(data):
    return subprocess.run(["cast", "keccak", data], capture_output=True, text=True, check=True).stdout.strip().lower()


def leaf(index, account, amount):
    enc = subprocess.run(
        ["cast", "abi-encode", "f(uint256,address,uint256)", str(index), account, str(amount)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return keccak(keccak(enc))


rows = [(0, sys.argv[1], 1000 * 10**18), (1, sys.argv[2], 2500 * 10**18)]
a, b = leaf(*rows[0]), leaf(*rows[1])
low, high = sorted([a, b])
print(json.dumps({
    "root": keccak("0x" + low[2:] + high[2:]),
    "textHash": keccak("0x" + b"an invented text for the chain loop".hex()),
    "total": str(sum(r[2] for r in rows)),
    "rows": len(rows),
    "amounts": [str(r[2]) for r in rows],
    "proofs": [[b], [a]],
}))
