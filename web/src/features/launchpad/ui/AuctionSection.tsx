import { useCallback, useState } from "react";

import type { Launch } from "../models";
import { AuctionDeployPanel } from "./AuctionDeployPanel";
import { GraduationPanel } from "./GraduationPanel";

/**
 * The money steps after the token exists: deploy the auction, then graduate.
 *
 * Linking the deployed auction republishes the launch record with its `auction`
 * tag, which is also what makes the graduation step relevant. If the deploy
 * panel simply unmounted at that moment, the founder would lose the
 * confirmation and the addresses of what they just deployed the instant it
 * succeeded. So a deploy that completed HERE keeps its panel (result and
 * addresses) on screen, with the graduation panel appearing below it; a launch
 * that arrives already linked shows only the graduation step.
 */
export function AuctionSection({
  launch,
  onLink,
  onSetTreasury,
}: {
  launch: Launch;
  /** Publishes the launch record with the deployed auction; must PROPAGATE errors. */
  onLink: (input: { auction: string }) => Promise<unknown>;
  /** Publishes the launch record with its treasury; must PROPAGATE errors. */
  onSetTreasury: (address: string) => Promise<unknown>;
}) {
  const { record } = launch;
  const [deployedHere, setDeployedHere] = useState(false);

  const link = useCallback(
    async (input: { auction: string }) => {
      const result = await onLink(input);
      setDeployedHere(true);
      return result;
    },
    [onLink],
  );

  const canDeploy = Boolean(record.tokenPlan && record.token);
  return (
    <>
      {canDeploy && (!record.auction || deployedHere) ? (
        <AuctionDeployPanel
          launch={launch}
          onLink={link}
          onSetTreasury={onSetTreasury}
        />
      ) : null}
      {record.auction ? <GraduationPanel launch={launch} /> : null}
    </>
  );
}
