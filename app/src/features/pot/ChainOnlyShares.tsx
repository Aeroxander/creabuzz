/**
 * Your Shares when the server's record cannot be used (not readable, or none yet): the project's contracts are read from the
 * Launcher by its chain key, so a person who holds Shares can still see what they hold and take it out. It needs the
 * build's network and the project's chain key; with neither it says nothing.
 */
import { readPlatformDollar } from "@creaton/core/pot/pot-state.ts";
import { readProjectParts } from "@creaton/core/pot/pot-state.ts";
import { useQuery } from "@tanstack/react-query";
import { potNetwork } from "../../lib/pot-network";
import { Card } from "../../ui/card";
import { HoldingTop } from "./HoldingTop";
import { Holding } from "./YourShares";
import type { MoneyTarget } from "./target";
import { WalletGate, type Ready } from "./use-pot";

function Inner({
  chainKey,
  projectName,
  ready,
}: {
  chainKey: string;
  projectName: string;
  ready: Ready;
}) {
  const network = potNetwork();
  const reading = useQuery({
    queryKey: ["pot", "parts", network?.launcher ?? "", chainKey],
    enabled: network !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<MoneyTarget> => {
      if (!network) throw new Error("No network.");
      const parts = await readProjectParts(
        ready.read,
        network.launcher,
        chainKey,
      );
      const dollar =
        network.dollar ??
        (await readPlatformDollar(ready.read, network.launcher));
      return {
        chainId: network.chainId,
        key: chainKey,
        treasury: parts.treasury,
        shares: parts.shares,
        team: parts.team,
        vester: parts.vester,
        dollar,
        playMoney: network.playMoney,
      };
    },
  });
  if (reading.isPending) return <Card className="h-20 animate-pulse" />;
  if (reading.isError)
    return (
      <p className="text-sm text-muted" data-testid="chain-only-failed">
        This project's contracts could not be found on the network from here, so
        your Shares cannot be shown. Your money is not affected.
      </p>
    );
  return (
    <>
      <HoldingTop
        onOpenMoney={() => {}}
        projectName={projectName}
        target={reading.data}
        tasks={null}
      />
      <Holding projectName={projectName} ready={ready} target={reading.data} />
    </>
  );
}

export function ChainOnlyShares({
  chainKey,
  projectName,
}: {
  chainKey: string | null;
  projectName: string;
}) {
  const network = potNetwork();
  if (!network || !chainKey) return null;
  return (
    <Card className="flex flex-col gap-3" data-testid="chain-only-shares">
      <h2 className="headline text-xl">Your Shares</h2>
      <p className="text-sm text-muted">
        The project's numbers are not available, but your Shares are read
        straight from the network, so you can still take them out.
      </p>
      <WalletGate chainId={network.chainId} what="see your Shares">
        {(ready) => (
          <Inner chainKey={chainKey} projectName={projectName} ready={ready} />
        )}
      </WalletGate>
    </Card>
  );
}
