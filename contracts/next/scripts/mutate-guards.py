#!/usr/bin/env python3
"""Remove one guard at a time from the milestone 2 sources and check that a test fails (a "mutation run").

    python3 scripts/mutate-guards.py            # every removal, unit/fuzz/attack suites (about 75 seconds each)
    python3 scripts/mutate-guards.py T09 L03    # only these ids
    INV_ONLY=1 python3 scripts/mutate-guards.py T10 T15   # only the invariant suite

Each removal edits one file under src/, runs `forge test` on the milestone 2 tests, prints one JSON line (the tests that
failed) and puts the file back with `git checkout`. It refuses to start if src/ has uncommitted changes, because the
restore would throw them away. Stored fuzz and invariant failures are deleted before every run, because Foundry replays
them and would blame a later removal for an earlier one's failure. A line with "n": 0 is a guard no test needs.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = dict(os.environ)
M1 = 'test/{Attacks,ForkFacts,ForkPick,Measure,Pieces,Route,UniversalRouter}.t.sol'
# (id, what is removed or broken, file, old, new, run invariants too)
T='src/Treasury.sol'; V='src/Vester.sol'; S='src/ShareToken.sol'; R='src/RollingCap.sol'; L='src/Launcher.sol'
MUT=[
('T01','Treasury: initialize may be called again',T,'if (founder != address(0)) revert BadSetup();','',False),
('T02','Treasury: no re-entrancy lock',T,'if (_locked) revert Reentrancy();','',False),
('T03','Treasury: anybody may declare the pool open',T,'if (msg.sender != opener) revert NotAllowed();','',False),
('T04','Treasury: the pool may be declared open twice',T,'if (poolOpen) revert PoolAlreadyOpen();','',False),
('T05','Treasury: settle works with no proven pool',T,'if (!poolOpen) revert NoPool();','',False),
('T06','Treasury: settle may split more than arrived',T,'if (amount > arrived) revert NotArrived(amount, arrived);','',False),
('T07','Treasury: settle ratio is not 15:60',T,'amount * spendableParts / (spendableParts + floorParts)','amount * spendableParts / (spendableParts + floorParts) * 2',True),
('T08','Treasury: any settle renews the check-in window',T,'if (!settled) {\n            (settled, accruedUpTo, lastCheckIn) = (true, block.timestamp, block.timestamp);\n        }','settled = true; accruedUpTo = block.timestamp; lastCheckIn = block.timestamp;',False),
('T09','Treasury: hand back before the sale money is split',T,'if (!settled) revert NotSettled();','',False),
('T10','Treasury: the Vester counts in the exit denominator',T,' - shares.balanceOf(address(vester));',';',True),
('T11','Treasury: the Treasury counts in the exit denominator',T,'shares.totalSupply() - shares.balanceOf(address(this)) - shares.balanceOf(address(vester))','shares.totalSupply() - shares.balanceOf(address(vester))',True),
('T12','Treasury: the exit slice reaches spendable',T,'uint256 slice = floorTotal * amount / counting;','uint256 slice = (floorTotal + spendable) * amount / counting;',True),
('T13','Treasury: no exit fee',T,'paid = slice - (slice * exitFeeBps + BPS - 1) / BPS;','paid = slice;',True),
('T14','Treasury: exit fee rounds down',T,'(slice * exitFeeBps + BPS - 1) / BPS','(slice * exitFeeBps) / BPS',False),
('T15','Treasury: the platform part of the fee is not recorded',T,'        feesOwed += toPlatform;\n','',True),
('T16','Treasury: an exit does not burn the Shares',T,'        shares.burnFrom(msg.sender, amount);\n','',True),
('T17','Treasury: an exit does not first work out the daily release',T,'        if (amount == 0) revert BadInput();\n        _accrue();\n        uint256 counting','        if (amount == 0) revert BadInput();\n        uint256 counting',False),
('T18','Treasury: the release ignores the check-in window',T,'uint256 upto = block.timestamp < end ? block.timestamp : end;','uint256 upto = block.timestamp; end;',False),
('T19','Treasury: anyone may check in',T,'if (msg.sender != founder && !agents[msg.sender].active) revert NotAllowed();','',False),
('T20','Treasury: an agent spends with no daily cap',T,'_agentUsd[msg.sender].consume(DAY, DAY_PARTS, a.usdCap, amount);','',False),
('T21','Treasury: spend does not stop at spendable (error kind)',T,'if (amount > spendable) revert TooMuch(amount, spendable);','',False),
('T22','Treasury: an agent gives Shares with no daily cap',T,'_agentShares[msg.sender].consume(DAY, DAY_PARTS, a.shareCap, amount);','',False),
('T23','Treasury: no monthly cap on gifts after the pool',T,'_gifts.consume(MONTH, MONTH_PARTS, shares.totalSupply() * GIFT_CAP_BPS / BPS, amount);','',True),
('T24','Treasury: gifts before the pool go straight to the person',T,'if (poolOpen) {\n            _gifts','if (true) {\n            _gifts',False),
('T25','Treasury: the work pot may be overdrawn (error kind)',T,'if (amount > workPot) revert WorkPotShort(amount, workPot);','',False),
('T26','Treasury: anyone may take the reserve out',T,'if (msg.sender != salePath) revert NotAllowed();','',True),
('T27','Treasury: anyone may set agents',T,'        if (msg.sender != founder) revert NotAllowed();\n        if (agent == address(0)) revert BadInput();','        if (agent == address(0)) revert BadInput();',False),
('T28','Treasury: anyone may switch agents off',T,'        if (msg.sender != founder) revert NotAllowed();\n        agents[agent].active = false;','        agents[agent].active = false;',False),
('T29','Treasury: an outgoing token fee is not noticed',T,'if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','',False),
('T30','Treasury: a pulled amount is credited as asked, not as received',T,'got = quote.balanceOf(address(this)) - before;','got = amount;',False),
('T31','Treasury: fees are swept to the caller',T,'_pay(platform, owed);','_pay(msg.sender, owed);',False),
('T32','Treasury: fees owed count as new money',T,'uint256 accounted = spendable + melting + permanentFloor + feesOwed;','uint256 accounted = spendable + melting + permanentFloor;',False),
('T33','Treasury: a second sale restarts the clock at a year',T,'meltRemaining = m == 0 ? RELEASE_PERIOD : (m * meltRemaining + toFloor * RELEASE_PERIOD) / (m + toFloor);','meltRemaining = RELEASE_PERIOD;',False),
('T34','Treasury: release is a share of the original deposit, not of what is left',T,'return (m * active / remaining, remaining - active);','return (m * active / RELEASE_PERIOD, remaining - active);',False),
('T35','Treasury: gifts to the Vester address are allowed',T,'|| to == address(vester) ||','||',False),
('T36','Treasury: more than the counting supply may be handed back (error kind)',T,'if (amount > counting) revert TooMuch(amount, counting);','',False),
('T37','Treasury: a hand back that pays nothing still burns',T,'if (paid == 0) revert NothingToPay();','',False),
('T38','Treasury: the exit takes everything from the melting floor',T,'uint256 fromPermanent = leaves * permanentFloor / floorTotal;','uint256 fromPermanent = 0;',False),
('T39','Treasury: shareRevenue goes to the melting floor',T,'permanentFloor += got;\n        emit ShareRevenue','melting += got;\n        emit ShareRevenue',False),
('T40','Treasury birth check: an exit fee of 100% or more is accepted',T,'|| s.exitFeeBps >= BPS ||','||',False),
('V01','Vester: anyone may start the clock',V,'if (msg.sender != starter) revert NotAllowed();','',False),
('V02','Vester: the clock may be started twice',V,'if (start != 0) revert WrongPhase();\n        start = block.timestamp;','start = block.timestamp;',False),
('V03','Vester: grants may be added after the clock started',V,'if (start != 0) revert WrongPhase();\n        _grant','_grant',False),
('V04','Vester: a grant needs no Shares behind it',V,'if (shares.balanceOf(address(this)) < committed + amount) revert NotFunded();','',False),
('V05','Vester: Shares release before the clock starts',V,'if (s == 0) return 0;','if (s == 0) s = 1;',False),
('V06','Vester: the release does not stop at the grant',V,'return elapsed >= DURATION ? total : total * elapsed / DURATION;','return total * elapsed / DURATION;',False),
('V07','Vester: initialize may be called twice',V,'if (starter != address(0)) revert AlreadyInitialized();','',False),
('V08','Vester: a claim does not record what was claimed',V,'        grants[beneficiary].claimed += amount;\n','',False),
('V09','Vester: anyone may add grants',V,'if (msg.sender != granter) revert NotAllowed();','',False),
('S01','ShareToken: birth may be repeated',S,'if (_born || to.length != amounts.length) revert BadBirth();','if (to.length != amounts.length) revert BadBirth();',False),
('S02','ShareToken: birth amounts need not add up to the supply',S,'if (sum != SUPPLY) revert BadBirth();','',False),
('S03','ShareToken: burnFrom ignores the allowance',S,'        _spendAllowance(from, value);\n        _burn(from, value);','        _burn(from, value);',False),
('S04','ShareToken: transferFrom ignores the allowance',S,'        _spendAllowance(from, value);\n        _move(from, to, value);','        _move(from, to, value);',False),
('S05','ShareToken: the implementation is not locked',S,'        _born = true; // the copy the clones point at can never be initialised','',False),
('R01','RollingCap: no cap check',R,'if (already + amount > cap) revert CapExceeded(already, amount, cap);','',False),
('R02','RollingCap: only the newest part counts',R,'if ((e >> 192) + buckets >= cur) sum += e & MASK;','if ((e >> 192) == cur) sum += e & MASK;',False),
('R03','RollingCap: a used amount stops counting one part early',R,'if ((e >> 192) + buckets >= cur) sum += e & MASK;','if ((e >> 192) + buckets > cur) sum += e & MASK;',False),
('L01','Launcher: a founder may reuse an id (error kind)',L,'if (_projects[key].shares != address(0)) revert ProjectExists();','',False),
('L03','Launcher: a sale may open with a guard that names someone else',L,'if (creator != strategy) revert NoPoolGuard();','',False),
('L04','Launcher: a sale may open with a hook that is not a guard',L,'        } catch {\n            revert NoPoolGuard();\n        }','        } catch {}',False),
('L05','Launcher: anyone may change settings',L,'        if (msg.sender != admin) revert NotAdmin();\n        _set(next);','        _set(next);',False),
('L06','Launcher: the exit fee ceiling is not checked',L,'s.exitFeeBps > MAX_EXIT_FEE_BPS ||','',False),
('L08','Launcher: the sale opens without a known project',L,'if (_projects[keyOf(msg.sender, projectId)].shares == address(0)) revert UnknownProject();','',False),
('L09','Launcher: the founder allocation is 190M not 200M',L,'uint256 public constant FOUNDER = 200_000_000e18;','uint256 public constant FOUNDER = 190_000_000e18;',False),


('L02','Launcher: a sale may open with no hook or no contract there',L,'poolHook.code.length == 0','false',False),
('L07','Launcher: the platform part may exceed the whole fee',L,'|| s.platformFeeBps > s.exitFeeBps','',False),
('L10','Launcher: the founder is the Launcher, not the caller',L,'                    founder: msg.sender,','                    founder: address(this),',False),
('T41','Treasury: the reserve ignores Shares returned or donated to it',T,'return shares.balanceOf(address(this)) - workPot;','return 100_000_000e18;',False),
('T29b','Treasury: raw transfer, no balance measurement on the way out (both layers)',T,'quote.safeTransfer(to, amount);\n        uint256 afterBal = quote.balanceOf(address(this));\n        if (afterBal > before || before - afterBal != amount) revert TokenMisbehaved();','quote.transfer(to, amount);',False),
('T30b','Treasury: raw transferFrom, no arrival check on the way in (both layers)',T,'quote.safeTransferFrom(msg.sender, address(this), amount);\n        got = quote.balanceOf(address(this)) - before;\n        if (got == 0) revert TokenMisbehaved();','quote.transferFrom(msg.sender, address(this), amount);\n        got = amount;',False),
('T42','Treasury birth check: a platform part above the whole fee is accepted',T,'|| s.platformFeeBps > s.exitFeeBps ||','||',False),
('T43','Treasury: a check-in does not first work out the release',T,'        _accrue();\n        lastCheckIn = block.timestamp;','        lastCheckIn = block.timestamp;',False),
('T44','Treasury: spend does not work out the release first',T,'        _accrue();\n        if (amount > spendable)','        if (amount > spendable)',False),
('T45','Treasury: the exit takes the fee from the floor instead of leaving it (the 4 percent leaves too)',T,'uint256 leaves = paid + toPlatform;','uint256 leaves = slice;',True),
('T46','Treasury: an exit pays twice its slice',T,'uint256 slice = floorTotal * amount / counting;','uint256 slice = floorTotal * amount / counting * 2;',False),
('T47','Treasury: the platform part is recorded twice',T,'feesOwed += toPlatform;','feesOwed += toPlatform * 2;',False),
('T48','Treasury: spend lets spendable fall below zero silently',T,'if (amount > spendable) revert TooMuch(amount, spendable);\n        spendable -= amount;','spendable = spendable > amount ? spendable - amount : 0;',False),
]

status = subprocess.run(['git', 'status', '--porcelain', 'src'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
if status:
    sys.exit('src/ has uncommitted changes; commit or stash them first:\n' + status)

def run(extra):
    subprocess.run('find cache/fuzz cache/invariant -type f -delete 2>/dev/null',shell=True,cwd=ROOT)
    cmd=['forge','test','--no-match-path',M1]+extra
    p=subprocess.run(cmd,cwd=ROOT,env=ENV,capture_output=True,text=True)
    out=p.stdout+p.stderr
    fails=[]
    for line in out.splitlines():
        if line.startswith('[FAIL'):
            m=re.findall(r'\] (\w+)\(',line)
            inv=re.findall(r'(invariant_\w+)',line)
            if inv: fails.append(inv[0])
            elif m: fails.append(m[-1])
    for line in out.splitlines():
        m2=re.match(r'^\s+(invariant_\w+)\(\) \(runs',line)
        if m2: fails.append(m2.group(1))
    total=re.findall(r'Encountered a total of (\d+) failing',out)
    comp='Compiler run failed' in out
    return sorted(set(fails)),comp,out,total
sel=sys.argv[1:] 
for (i,desc,f,old,new,inv) in MUT:
    if sel and i not in sel: continue
    path=os.path.join(ROOT,f)
    src=open(path).read()
    if src.count(old)!=1:
        print(json.dumps({'inv_only':bool(os.environ.get('INV_ONLY')),'id':i,'error':'old string count %d'%src.count(old)}),flush=True); continue
    open(path,'w').write(src.replace(old,new))
    try:
        extra=['--match-contract','Invariants'] if os.environ.get('INV_ONLY') else ['--no-match-contract','Invariants']
        fails,comp,out,total=run(extra)
    finally:
        subprocess.run(['git','checkout','--',f],cwd=ROOT,check=True)
    print(json.dumps({'inv_only':bool(os.environ.get('INV_ONLY')),'id':i,'what':desc,'compile_failed':comp,'failed':fails[:8],'n':len(fails),'total_failing_reported':total}),flush=True)
