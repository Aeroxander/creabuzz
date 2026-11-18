// Moves a founder (or any bloc) can make with the vote, per the code.
const pct = (x) => (x * 100).toFixed(1) + "%";
// 1) Founder vetoes contributors' awards (bounded lane 10%/55%, opposition free: AllocationVoting.sol:23-30, 495-501)
console.log("== Founder votes NO on a contributor's award (bounded lane: yes must be >= 55% of yes+no) ==");
for (const [m, S, F] of [[6, 2_100_000, 1_100_000], [12, 3_200_000, 1_200_000], [24, 5_700_000, 1_500_000]]) {
  const needYes = F * 55 / 45, others = S - F;
  console.log(`month ${m}: to pass over the founder's ${F.toLocaleString()} NO, contributors need ${Math.ceil(needYes).toLocaleString()} YES = ${pct(needYes / others)} of all non-founder Shares${needYes > others ? " (impossible)" : ""}`);
}
// 2) Founder lowers the full lane to its floor: setLane(false, 500, 5001, 1 day, 0, true) (AllocationVoting.sol:205-215)
console.log("\n== Founder carries setLane(full, 5% turnout, 50.01% agreement) ==");
for (const [m, S, F] of [[12, 3_200_000, 1_200_000], [24, 5_700_000, 1_500_000]]) {
  const others = S - F;
  const before = F * 34 / 66 / others, after = F * 4999 / 5001 / others;
  console.log(`month ${m}: share of others who must vote NO to block a founder-only YES: ${pct(before)} -> ${pct(after)}; founder alone meets turnout until supply ${(F / 0.20).toLocaleString()} -> ${(F / 0.05).toLocaleString()}`);
}
// 3) Governance freeze: Moloch setters have no upper bound (MolochPatched.sol:1209-1220, 1252); openProposal uses max(lane, governor) (AllocationVoting.sol:247-251) and minYes as is
console.log("\n== One vote that ends voting for good ==");
const S = 5_700_000;
const moves = [
  ["setMinYesVotesAbsolute(type(uint96).max)", "every later decision needs more YES than exist"],
  ["setQuorumBps(10000)", `every later decision needs all ${S.toLocaleString()} voting Shares to take part (one holder who never votes blocks it)`],
  ["setProposalThreshold(> largest holding)", "nobody can open a decision, including the one that would undo it"],
];
for (const [call, effect] of moves) console.log(`  ${call}: ${effect}`);
console.log("  setLane refuses quorum > 60% so a DAO 'could never lower it again' (its own comment); these three bypass that guard");
// at month 24 the founder (26.3%) passes any of these unopposed:
console.log(`  at month 24 founder ${pct(1_500_000 / S)} >= 20% turnout: passes it if fewer than ${pct(1_500_000 * 34 / 66 / (S - 1_500_000))} of others vote no in ~3 days`);

// 4) Reviewer collusion, §8c budget (3,000,000 Shares, 100,000 a project), kit bond = 0 (ContributorKit.sol:143)
console.log("\n== Two of three reviewers approve a friend's claim (first budget, kit-made: no bond) ==");
const perProject = 100_000, budget = 3_000_000;
for (const [m, S] of [[6, 2_100_000], [12, 3_200_000], [24, 5_700_000]]) {
  console.log(`month ${m}: one friend claim = up to ${perProject.toLocaleString()} Shares = ${pct(perProject / (S + perProject))} of the project after it; bond at risk $0`);
}
console.log(`whole remaining budget at month 12 (${(budget - 2_200_000).toLocaleString()} left): ${pct(800_000 / (3_200_000 + 800_000))} of the project`);
// Can they reach the award without the founder? Need bounded 10% turnout; founder NO at 1.2M (month 12) needs 1.467M YES.
console.log("needs: a project whose manager binds the claim (founder manages every first project), and an award vote (10%/55%)");
// Remedy cost: reviewers are fixed for the budget's life (VerifierSet owner = the budget, which never calls accept/remove after its constructor);
// close() stops every award from it (TreasuryMandate.sol:278), including honest claims already Paid but not yet awarded.
for (const pending of [3, 10]) console.log(`  closing the budget to stop the panel also voids ${pending} honest approved claims waiting for their award vote (up to ${(pending * perProject).toLocaleString()} Shares)`);

// 5) Late-objection squatting (fundraising kit, MilestoneChallenge.sol:355-371): one late objection per milestone.
console.log("\n== Fundraising kit: the one late objection, used up by an ally (CHALLENGE_DEFAULTS, daoLaunch.ts:86-99) ==");
const raise = 50_000, bond = raise * 0.01, deposit = bond * 0.10, clawback = 30, votePeriod = 5;
console.log(`$50,000 film: bond $${bond}, objector deposit $${deposit}. An ally (a buyer, not on the team) objects late on day 0 after an unlock; holders must vote it up within ${votePeriod} days (>= 3% of eligible and more than accept).`);
console.log(`If they don't, the milestone is safe from day ${votePeriod} instead of day ${clawback}; a fault found on days ${votePeriod + 1}-${clawback} can burn nothing. Ally's cost: the $${deposit} deposit.`);
