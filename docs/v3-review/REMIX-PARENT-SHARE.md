# Remixes, step two: the parent's share (N12, 2026-10-26 as D124)

Status: **the remix bond is built for test networks; the parent's locked share is specified, not built.** Step one
(N11, D121) records where a project comes from with no money. This is the money step, in parts that can each be
released on their own.

## Built: a remix bond, decided by the court

`contracts/src/RemixBond.sol`, on a remix's page under **Where it comes from**:

- A project built on another posts a bond in $CREATE for its parent, held for 30 days to two years, against the parent's
  remix terms. Their words are kept with the bond (their hash on chain, the words in its event), so a case judges them
  as they were when it was posted.
- **Anyone can take it to the court** during the term, paying the court's fee: "it broke the terms". One case at a time.
- **Upheld:** the bond is the parent DAO's, sent there by anyone, and both pages say "broke its remix terms". That is the
  whole remedy: nobody's tokens are taken and leaving stays open in both projects.
- **Any other ruling** leaves it held. **After the term**, with no case open, anyone returns it to whoever posted it.

Why a bond first: it needs no change to how a remix is launched, it is backed by the court that now exists (N7, D119),
and it gives the parent a real remedy without any power over the remix.

## Specified: the parent's locked share in the remix's starting Shares

A remix can give its parent a share of its starting supply, declared at launch:

| Part | Rule |
|---|---|
| Where it comes from | The remix's genesis allocation: a new kit choice `parent` and `parentShareBps`, at most 10%. No new Shares later (D76) |
| How it is held | By a `ParentShareLock`, a variant of the milestone lock: Shares minted to it, released to the parent DAO when the remix's first milestone is accepted (raise DAOs) or after a set time (contributor projects, which have no milestones) |
| While locked | Not counted in leaving, payouts or votes, exactly like the team's locked Shares (D72); so the parent cannot leave with the remix's early treasury |
| Once released | Ordinary Shares held by the parent's DAO: they vote, count for leaving, and receive the remix's payouts (N10) like anyone's |
| Revenue share | Needs nothing new: a parent holding Shares receives the remix's payouts (N10). A bigger share is a bigger allocation |
| Only the direct parent | A grandparent is paid through the parent's own share |

What it needs: the kit change (both kits), the lock variant with its own tests and audit, and a launch form choice. It
belongs with stage 3, after the audited raise, because a released share is a claim on a treasury.

## Parked

An apptoken cut on trading venues (no venue is integrated, LBAMM is evaluation only); a remix licence for copies made
outside Creaton (needs the legal entity).

## Open, for you

Whether parents should be able to require a bond (today it is the remix's choice); a cap on bonds; whether the parent's
share should be a default suggestion in remix terms (open question 6 in NEXT-GEN-DAO.md).
