/**
 * Team Shares on the Money tab: for the runner (and a Pair's signers) the grant button and the pool, for a member their own
 * grants. Both say plainly that Team Shares claim only the project's money above what backers put in.
 */
import { useId, useState } from "react";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { ProjectNumbers } from "../money/numbers";
import { runnerRole } from "../money/runner";
import { GrantSheet, type GrantMember } from "./GrantSheet";
import { MyGrants } from "./MyGrants";
import { sharesWords, teamPartPercent } from "./pot-words";
import { type Ready, WalletGate } from "./use-pot";

export function TeamSharesSection({
  numbers,
  address,
  members,
}: {
  numbers: ProjectNumbers;
  address: string | null;
  members: GrantMember[];
}) {
  const titleId = useId();
  const role = runnerRole(numbers, address);
  const isMember = Boolean(
    address &&
      numbers.team.grants.some((g) => g.member === address.toLowerCase()),
  );
  if (role.kind === "none" && !isMember) return null;
  return (
    <Card
      aria-labelledby={titleId}
      className="flex flex-col gap-3"
      data-testid="team-shares"
      role="region"
    >
      <h2 className="headline text-xl" id={titleId}>
        Team Shares
      </h2>
      <p className="text-sm text-muted" data-testid="team-shares-words">
        Team Shares claim only the project's money above what backers put in
        {teamPartPercent(numbers) !== null
          ? `, and the Team's side gets ${teamPartPercent(numbers)}% of that`
          : ""}
        . If there is none, they are worth nothing.
      </p>
      <WalletGate chainId={numbers.chainId} what="see your Team Shares">
        {(ready) => (
          <Inner
            members={members}
            numbers={numbers}
            ready={ready}
            role={role.kind}
          />
        )}
      </WalletGate>
    </Card>
  );
}

function Inner({
  numbers,
  ready,
  members,
  role,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  members: GrantMember[];
  role: "alone" | "signer" | "none";
}) {
  const [granting, setGranting] = useState(false);
  return (
    <>
      {role !== "none" ? (
        <>
          <p className="text-sm" data-testid="team-shares-pool">
            {sharesWords(numbers.team.ungranted)} of the{" "}
            {sharesWords(numbers.team.pool)} Team Shares are left to grant.
          </p>
          <Button
            block
            data-testid="grant-open"
            disabled={
              numbers.windDown !== null || numbers.team.ungranted === 0n
            }
            onClick={() => setGranting(true)}
          >
            Grant Team Shares
          </Button>
          <GrantSheet
            members={members}
            numbers={numbers}
            onClose={() => setGranting(false)}
            open={granting}
            ready={ready}
          />
        </>
      ) : null}
      <MyGrants numbers={numbers} ready={ready} />
    </>
  );
}
