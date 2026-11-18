# Attacker-economist checks. SIMULATED. Plain constant-product pool, 1% fee on the way in.
M=1e6
def sell(pd,ps,s,fee=0.01):
    s_in=s*(1-fee); out=pd*s_in/(ps+s_in); return out,pd-out,ps+s_in
def best_mix(floor,count,pd,ps,S,exit_net):
    # split S free Shares between pool dump and floor hand-back; pool Shares count in floor denominator
    best=(0,0,0,0)
    for i in range(0,101):
        d=S*i/100; h=S-d
        o,_,_=sell(pd,ps,d) if d>0 else (0,0,0)
        hb=floor*h/count*exit_net
        if o+hb>best[0]: best=(o+hb,i,o,hb)
    return best
print("== A. Market auction 50,000 honest, founder holds 150M self-filled backing Shares (cost 1,200 fees)")
raise_=50000; pd=0.42*raise_; ps=pd/0.0004; fl=0.44*raise_; once=0.11*raise_
sold=raise_/0.0004; count=sold+150*M+ps
for S in (25*M,50*M,150*M):
    cost={25*M:75,50*M:75+ (25*M*0.0002*0.03),150*M:1200}[S]
    for net,label in ((0.95,"built fee"),(0.99,"design-1 fee (4 returns to founder)")):
        t,i,o,hb=best_mix(fl,count,pd,ps,S,net)
        print(f" free Shares {S/M:.0f}M {label}: best = {i}% to pool -> pool {o:,.0f} + floor {hb:,.0f} = {t:,.0f}; plus {once:,.0f} at once; honest put in {raise_:,}; fees paid {cost:,.0f}")
print(" same with pool at 22% and Large 250,000 (55,000 pool, 150,000 floor, 250M sold)")
pd2=55000; ps2=55*M; fl2=150000; c2=250*M+150*M+ps2
for net in (0.95,0.99):
    t,i,o,hb=best_mix(fl2,c2,pd2,ps2,150*M,net); print(f"  net {net}: {i}% to pool, pool {o:,.0f} + floor {hb:,.0f} = {t:,.0f} (+37,500 at once)")
print("== A2. honest backers only: Solo backers paid 0.0001, pool opens at 0.0004")
for S in (25,87.5,150):
    o,p,s=sell(pd,ps,S*M); print(f" {S}M sold: take {o:,.0f} ({o/pd:.0%} of pool), price x{(p/s)/0.0004:.2f}")
print("== B. true cost of a founder faking the whole 50,000 auction (sells bought Shares back into the pool, keeps 11+44 as project)")
for extra in (0,150):
    S=sold+extra*M; o,_,_=sell(pd,ps,S)
    print(f" backing Shares also dumped {extra}M: recovers {o:,.0f} of the 21,000 pool; lost for good = 1,500 fee + {pd-o:,.0f} = {1500+pd-o:,.0f} ({(1500+pd-o)/raise_:.1%}), claimed 45%")
print(" built Standard (22% pool): bid X alone, sell all bought Shares: pool recovered",f"{0.99/(0.22+0.99)*100:.0f}% -> lost {3+22*(1-0.99/(0.22+0.99)):.1f} of 100, claimed 25")
print(" top-up case: honest 30,000, founder adds 20,000 then sells its 50M Shares")
o,_,_=sell(pd,ps,20000/0.0004); print(f"  recovers {o:,.0f}; net cost of the 20,000: fee 600 + pool 8,400 - {o:,.0f} = {9000-o:,.0f} (claimed 9,000)")
print("== C. shared floor across plain rounds at the SAME price (Design 3 uses the built Treasury for plain rounds)")
f1=2050/2; s1=1.0; f2=8200; s2=4.0; fps=(f1+f2)/(s1+s2)
print(f" old backers' claim per Share {f1/s1:.0f} -> {fps:.0f} ({fps/(f1/s1)-1:+.0%}); new backers {f2/s2:.0f} -> {fps:.0f} ({fps/(f2/s2)-1:+.0%}); moved from new to old {fps*s1-f1:,.0f} dollars")
print("== D. park to pause with founder-owned 'sold' Shares in the count (Design 3 share budgets)")
for plain_self,auction_honest,plain_honest in ((200,200,0),(100,200,100),(200,0,0),(50,0,50)):
    sold_=plain_self+auction_honest+plain_honest; hon=auction_honest+plain_honest
    p=0.25*sold_/hon if hon else float('inf'); s=0.5*sold_/hon if hon else float('inf')
    print(f" founder wallets {plain_self}M, honest {hon}M: pause needs {p:.0%} of honest, stop needs >{s:.0%}", "(impossible)" if s>=1 else "")
print(" cost to the founder of 200M self-filled plain Shares at Design 3 caps: 3% of 50,000 = 1,500")
print(" council: founder wallets 200M of 400M parked-capable Shares = 50% -> wins at least 1 of every 2 seats + reserved seat")
print("== E. matching pot on a shared floor: match pays 100 into floor, backers paid 82")
b=5000; m=2500; fl_=0.82*b+m; shares_b=1.0; shares_m=0.5
claim_b=fl_*shares_b/(shares_b+shares_m)
print(f" backers' floor claim {0.82*b:,.0f} -> {claim_b:,.0f} (+{claim_b-0.82*b:,.0f}, {(claim_b-0.82*b)/m:.0%} of the match leaks to backers at once)")
print(f" faker hands back at once: {0.15*b:,.0f} + {claim_b*0.95:,.0f} = {0.15*b+claim_b*0.95:,.0f} of {b:,} (design said 4,645)")
print("== F. Creaton's free 2% priced at Design 1 stage prices")
for nm,price,rnd in (("Solo",0.0001,2500),("Backed",0.0002,10000),("Team",0.0004,25000),("Market",0.0004,50000)):
    print(f" {nm}: 20M Shares = {20*M*price:,.0f} dollars at the round price; round of {rnd:,} buys {rnd/price/M:.1f}M Shares; stake = {20*M*price/rnd:.0%} of the round")
print("== G. bear-year income with the other designers' sizes (no auction under 50,000)")
for nb,avg,na,aavg,poolpct,floorpct in ((185,3000,15,30000,.22,.60),(197,3000,3,50000,.42,.44),(199,3000,1,50000,.42,.44),(200,3000,0,0,0,0)):
    rb=nb*avg; ra=na*aavg; fee=0.03*(rb+ra); tr=ra*poolpct*10*0.0025; ex=(0.82*rb+floorpct*ra)*0.25*0.01
    tot=fee+tr+ex+2500+2400
    print(f" {nb} rounds x {avg:,} + {na} auctions x {aavg:,}: raised {rb+ra:,.0f}; cash {tot:,.0f}; running 40% {0.4*tot:,.0f}; pot 30% {0.3*tot:,.0f} ({0.3*tot/8:,.0f} a season)")
print("== H. scale-back with free pull-out: 500 accounts ask 125,000, honest 4,800")
print(f" during window honest see fill {2500/129800:.1%}; if attacker pulls down to 2,500 in the last block honest who stayed get {2500/7300:.0%} each, attacker {2500/7300:.0%} of round at zero cost; if honest left, attacker takes 100%")
print("== I. fallback team clock: founder Shares free at pool open if graduation is late")
for months in (12,18,24):
    rel=min(1,(months-12)/12)*200*M
    if rel: o,p,s=sell(pd,ps,rel); print(f" pool opens month {months}: {rel/M:.0f}M free -> takes {o:,.0f} ({o/pd:.0%}), price x{(p/s)/0.0004:.2f}")
    else: print(f" pool opens month {months}: 0 free")
print("== J. decaying sell fee fix: 150M dumped, fee f kept in pool")
for f in (0.01,0.25,0.5,0.75):
    o,p,s=sell(pd,ps,150*M,f); print(f" sell fee {f:.0%}: seller takes {o:,.0f}, price x{(p/s)/0.0004:.2f}")
print("== K. backing Shares delivered over 12 months from pool open (as team): free on day 30 = 150M/12")
o,p,s=sell(pd,ps,150*M/12); print(f" 12.5M: takes {o:,.0f}, price x{(p/s)/0.0004:.2f}")
print("== L. CREATE price rule: 1 fake fee dollar lifts the allowed round by")
print(" 20 x 1 x 10% = 2 dollars of round size; insider gets back 0.40 (running) + round money")
