"""Stage-ladder simulations. SIMULATED numbers, plain arithmetic, standard library only.
Assumptions are printed with each block. Nothing here was run on a chain."""
FEE = 0.01  # pool trade fee, plan section 4

def impact(pool_usd, buy):  # full-range constant-product pool, price move of a buy
    return (1 + buy * (1 - FEE) / pool_usd) ** 2 - 1

print("1. POOL DEPTH. Model: constant product, 1% fee. Check against measured (M3): 100 into 2,200 = 9.2%, into 880 = 23.7%")
print("   model: %.1f%%, %.1f%%" % (100 * impact(2200, 100), 100 * impact(880, 100)))
for raise_ in (10_000, 50_000, 100_000, 200_000, 250_000):
    p = 0.22 * raise_
    print("   raise %7d pool %6d: buy 100 -> +%.1f%%, buy 1,000 -> +%.1f%%, buy 2,500 -> +%.1f%%"
          % (raise_, p, 100 * impact(p, 100), 100 * impact(p, 1000), 100 * impact(p, 2500)))

print("\n2. MOST A FOUNDER SIDE CAN TAKE BEFORE BACKERS CAN PAUSE. Assumes: 15 of 100 at once, 82 (plain round) or 60 (auction)")
print("   paid evenly over 365 days, backers notice at day 14, pause lands 1 day after the quarter is parked (day 15).")
def take(raised, floor_part, days=15): return 0.15 * raised + floor_part * raised / 365 * days
for name, cap, fp in (("Backed", 10_000, 0.82), ("Team", 50_000, 0.82), ("Council", 250_000, 0.60)):
    t = take(cap, fp)
    print("   %-8s cap %7d: no extra rule %8.0f (%.1f%%)" % (name, cap, t, 100 * t / cap))
print("   Team, one signer alone at 500 per 7 days, 15 days: %d" % (500 * 3))
print("   Team, both signers together: same as no extra rule")
b = 0.06 * 250_000
print("   Council, operators inside the default budget (6%% of raised per 30 days): 15 days = %.0f, 30 days = %.0f" % (b / 2, b))

print("\n3. STOP VOTE. Old rule (plan): more than half yes, all founder Shares vote. Backers' turnout-and-yes needed to beat")
print("   the founder side voting no. F = founder 200M, G = Shares given to friends before the market.")
for sold in (100, 200, 400):
    for G in (0, 100, 200):
        need = (200 + G) / sold
        print("   sold %3dM, friends %3dM: backers need %s of their Shares voting yes"
              % (sold, G, ("%.0f%%" % (100 * need)) if need < 1 else "MORE THAN ALL (impossible)"))
print("   New rule: a quarter of the Shares that were sold or given after the market opened, parked 24 hours, pauses for")
print("   14 days; more than half keeps it stopped. Team Shares are not in the count, so the answer is 25% and 50% always.")
print("   If team Shares stayed in the count (founder 200M released, friends 100M, backers 400M): pause needs %.0f%% of"
      " backers, stop %.0f%%" % (100 * 0.25 * 700 / 400, 100 * 0.5 * 700 / 400))

print("\n4. WHY TEAM SHARES MUST NOT RELEASE BEFORE A MARKET. If the 365-day clock started at the first plain round,")
print("   the founder's released Shares would count for the floor. Share of the unpaid money backers could still take back:")
for sold in (100, 200, 400):
    row = []
    for d in (30, 90, 180, 365):
        row.append("day %d: %.0f%%" % (d, 100 * sold / (sold + 200 * d / 365)))
    print("   %3dM sold: %s" % (sold, ", ".join(row)))

print("\n5. TAKEOVER THROUGH THE POOL at Council. Assumes an auction goal of 200,000 selling 200M Shares at 0.001,")
print("   pool 44,000 dollars and 44M Shares, 400M Shares sold in all (100M Backed, 100M Team, 200M auction).")
D, S, base = 44_000.0, 44.0, 400.0
for q in (4.4, 11, 22, 33, 39.6):
    cost = D * (S / (S - q) - 1) / (1 - FEE)
    print("   buy %4.1fM Shares (%.1f%% of the voting base): %9.0f dollars, price ends %.1fx"
          % (q, 100 * q / base, cost, (S / (S - q)) ** 2))
print("   The pool can never supply more than 44M = 11% of the base. A third (133M) or two thirds (267M) must come from")
print("   holders who sell, or from bidding in the auction itself (up to 200M = 50%).")

print("\n6. COUNCIL SEATS. Each Share backs one candidate; top N win. A bloc with share f of the votes is sure of k of N")
print("   seats when f > k/(N+1).")
for N in (2, 4, 5):
    print("   %d seats: " % N + ", ".join("%d seat%s needs > %.0f%%" % (k, "" if k == 1 else "s", 100 * k / (N + 1)) for k in range(1, N + 1)))

print("\n7. FASTEST PATH. first round 1 day; Team after 4 weekly updates; Council after 12 weekly updates; Open 365 days after the market opens")
print("   Start -> Backed: day 2;  -> Team: day 30;  -> Council: day 86 (12 weeks + 1-day auction + finish);  -> Open: day %d" % (86 + 365))

print("\n8. GIFT DRAIN (B3) BY STAGE. Below the market gifts go to the Vester and do not count: drain 0 (code: Treasury.giveShares).")
print("   At Council: 10M Shares a month to fresh wallets handed straight back, floor 60%% of 200,000 melting evenly,")
fl, cnt, taken = 120_000.0, 444.0, 0.0
for m in range(1, 12):
    fl -= 120_000 / 12
    slice_ = fl * 10 / (cnt + 10)
    paid = slice_ * 0.95; fl -= slice_ * 0.96; taken += paid
print("   444M Shares counted: 11 monthly gifts take %.0f dollars in a year (%.1f%% of the 120,000 floor)." % (taken, 100 * taken / 120_000))
