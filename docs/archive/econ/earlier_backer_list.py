# Creaton's earlier backers: is the owner's list ready to send private links? Plain Python; openpyxl only to read the
# sheet. App and server lane, 18 November 2026.
#
# Run: python3 -I docs/archive/econ/earlier_backer_list.py <the owner's sheet.xlsx> [<private out.csv>]
#
# PRIVACY: the sheet holds backer names, amounts and wallet addresses. This script PRINTS COUNTS ONLY. The optional
# second argument writes the cleaned list (one row per entry, with what each needs before a link can go out) to a file
# the owner keeps private (the session scratchpad, never the repo). Nothing here is sent anywhere.
#
# What it checks, per entry of the backer table (Seed column G, Private column H, address column L, rows 19 to 42):
#   - an address is there, is 0x + 40 hex as typed, or only after taking out spaces and line breaks;
#   - mixed-case addresses carry an EIP-55 checksum: a typo in one letter fails it (all-lower or all-upper carry none);
#   - two entries naming the same address (one signature would answer for both: the owner must say whose it is);
#   - "DONE" or anything else in place of an address.
# It also re-adds the money and old tokens, so the totals match the facts the owner gave (sheet: 1,229,957 dollars,
# 31,754,500 old tokens, 21 entries).
import csv
import re
import sys
from collections import Counter

# Keccak-256 (the Ethereum hash, not NIST SHA3-256), standard library only, for the EIP-55 checksum.
_RC = [0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000, 0x000000000000808B,
       0x0000000080000001, 0x8000000080008081, 0x8000000000008009, 0x000000000000008A, 0x0000000000000088,
       0x0000000080008009, 0x000000008000000A, 0x000000008000808B, 0x800000000000008B, 0x8000000000008089,
       0x8000000000008003, 0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
       0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008]
_ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]]
_M64 = (1 << 64) - 1


def _rol(x, n):
    return ((x << n) | (x >> (64 - n))) & _M64 if n else x


def _f(a):
    for rc in _RC:
        c = [a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4] for x in range(5)]
        d = [c[(x - 1) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a = [[a[x][y] ^ d[x] for y in range(5)] for x in range(5)]
        b = [[0] * 5 for _ in range(5)]
        for x in range(5):
            for y in range(5):
                b[y][(2 * x + 3 * y) % 5] = _rol(a[x][y], _ROT[x][y])
        a = [[b[x][y] ^ ((~b[(x + 1) % 5][y]) & b[(x + 2) % 5][y]) for y in range(5)] for x in range(5)]
        a[0][0] ^= rc
    return a


def keccak256(data: bytes) -> bytes:
    rate = 136
    msg = bytearray(data) + b"\x01"
    while len(msg) % rate:
        msg += b"\x00"
    msg[-1] |= 0x80
    a = [[0] * 5 for _ in range(5)]
    for off in range(0, len(msg), rate):
        block = msg[off:off + rate]
        for i in range(rate // 8):
            a[i % 5][i // 5] ^= int.from_bytes(block[8 * i:8 * i + 8], "little")
        a = _f(a)
    out = b"".join(a[i % 5][i // 5].to_bytes(8, "little") for i in range(4))
    return out


assert keccak256(b"").hex() == "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"


def checksum(addr_lower_hex40: str) -> str:
    h = keccak256(addr_lower_hex40.encode()).hex()
    return "0x" + "".join(c.upper() if c.isalpha() and int(h[i], 16) >= 8 else c for i, c in enumerate(addr_lower_hex40))


# EIP-55's own example must pass, and the same address with one letter's case flipped must fail.
assert checksum("5aaeb6053f3e94c9b9a09f33669435e7ef1beaed") == "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"


def check_address(raw):
    """(state, normalised) where state is one of: missing, ok, ok_after_cleaning, bad_checksum, not_an_address."""
    if raw is None or str(raw).strip() == "":
        return "missing", None
    text = str(raw)
    cleaned = re.sub(r"\s", "", text)
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", cleaned):
        return "not_an_address", None
    body = cleaned[2:]
    if body != body.lower() and body != body.upper() and checksum(body.lower()) != cleaned:
        return "bad_checksum", cleaned.lower()
    return ("ok" if cleaned == text else "ok_after_cleaning"), cleaned.lower()


def main():
    import openpyxl  # read-only use; the file is the owner's

    path = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    ws = openpyxl.load_workbook(path, data_only=False).active
    seed_price, private_price = 0.02, 0.046  # sheet: B17 and B18
    entries = []
    for r in range(19, 43):
        name, seed, private, addr = (ws.cell(r, c).value for c in (6, 7, 8, 12))
        if seed is None and private is None:
            continue
        round_ = "seed" if seed else "private"
        usd = float(seed or private)
        price = seed_price if seed else private_price
        state, norm = check_address(addr)
        marker = str(addr).strip().upper() if state == "not_an_address" else ""
        entries.append(dict(row=r, round=round_, usd=usd, price=price, old_tokens=usd / price, name=name,
                            address=norm, address_state=state, marker=marker))

    n = len(entries)
    usd = sum(e["usd"] for e in entries)
    old = sum(e["old_tokens"] for e in entries)
    by_round = Counter(e["round"] for e in entries)
    states = Counter(e["address_state"] for e in entries)
    markers = Counter(e["marker"] for e in entries if e["marker"])
    addr_count = Counter(e["address"] for e in entries if e["address"])
    shared = {a for a, k in addr_count.items() if k > 1}
    entries_sharing = sum(1 for e in entries if e["address"] in shared)

    print("THE LIST (sheet; counts and totals only)")
    print(f"  entries {n}: seed {by_round['seed']}, private {by_round['private']}")
    print(f"  money {usd:,.0f} dollars, old tokens {old:,.0f} ({old / 110e6:.3%} of the old 110,000,000)")
    print("ADDRESSES")
    for k in ("ok", "ok_after_cleaning", "bad_checksum", "missing", "not_an_address"):
        print(f"  {k:18} {states.get(k, 0)}")
    for m, k in markers.items():
        print(f"    of which the cell says {m!r}: {k}")
    print(f"  distinct usable addresses {len(addr_count)}; addresses named by more than one entry {len(shared)} "
          f"({entries_sharing} entries)")
    usable = sum(1 for e in entries if e["address_state"] in ("ok", "ok_after_cleaning"))
    print("WHAT EACH ENTRY NEEDS BEFORE ITS LINK GOES OUT (judgement)")
    ready = sum(1 for e in entries if e["address_state"] in ("ok", "ok_after_cleaning") and e["address"] not in shared)
    print(f"  ready: a usable address of its own                         {ready}")
    print(f"  the owner says whose the shared address is                 {entries_sharing}")
    print(f"  the owner asks for an address (missing, DONE, not one)     {n - usable}")
    print(f"  the owner confirms the cleaned address with the backer     {states.get('ok_after_cleaning', 0)}")
    print("  (one of the seed entries is the owner's own; it goes back to the project, not through a link)")
    by_round_usd = {r: sum(e["usd"] for e in entries if e["round"] == r) for r in ("seed", "private")}
    no_addr_usd = sum(e["usd"] for e in entries if e["address_state"] not in ("ok", "ok_after_cleaning"))
    print(f"  money behind entries with no usable address {no_addr_usd / usd:.1%} of the total; "
          f"seed {by_round_usd['seed']:,.0f}, private {by_round_usd['private']:,.0f}")

    if out:
        with open(out, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["entry", "sheet_row", "round", "name", "dollars", "price_paid", "old_tokens", "address",
                        "address_state", "needs"])
            for i, e in enumerate(entries, 1):
                needs = []
                if e["address_state"] in ("missing", "not_an_address"):
                    needs.append("ask the backer for the address they paid from")
                if e["address_state"] == "ok_after_cleaning":
                    needs.append("confirm the cleaned address with the backer")
                if e["address_state"] == "bad_checksum":
                    needs.append("the address has a typo: ask the backer")
                if e["address"] in shared:
                    needs.append("two entries name this address: say whose it is")
                if e["marker"]:
                    needs.append(f"cell says {e['marker']}: find out what that means")
                w.writerow([i, e["row"], e["round"], e["name"], f"{e['usd']:.2f}", e["price"],
                            f"{e['old_tokens']:.0f}", e["address"] or "", e["address_state"], "; ".join(needs)])
        print(f"private list written ({n} rows); keep it out of the repo")


if __name__ == "__main__":
    main()
