import * as React from "react";

import {
  DEFAULT_RPC_ENDPOINT,
  getRpcEndpoint,
  setRpcEndpoint,
} from "@/features/launchpad/lib/chainRpc";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useQueryClient } from "@tanstack/react-query";

/** Point launchpad chain reads at an RPC endpoint (default: local Anvil). */
export function RpcEndpointControl() {
  const relayOrigin = getCachedRelayOrigin();
  const queryClient = useQueryClient();
  const [endpoint, setEndpoint] = React.useState(() =>
    getRpcEndpoint(relayOrigin),
  );
  const [open, setOpen] = React.useState(false);

  if (!open) {
    return (
      <button
        className="rounded-full bg-muted/70 px-2.5 py-1 text-2xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        title={`Chain RPC: ${endpoint}`}
        type="button"
      >
        RPC: {endpoint.replace(/^https?:\/\//, "").slice(0, 18)}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <label className="sr-only" htmlFor="launchpad-rpc">
        Chain RPC endpoint
      </label>
      <Input
        id="launchpad-rpc"
        className="h-7 w-44 text-2xs"
        onChange={(e) => setEndpoint(e.target.value)}
        placeholder={DEFAULT_RPC_ENDPOINT}
        value={endpoint}
      />
      <Button
        onClick={() => {
          setRpcEndpoint(relayOrigin, endpoint.trim() || DEFAULT_RPC_ENDPOINT);
          setOpen(false);
          void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        Save
      </Button>
    </span>
  );
}
