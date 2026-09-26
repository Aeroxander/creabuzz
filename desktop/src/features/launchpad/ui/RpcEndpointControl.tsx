import * as React from "react";

import {
  CHAIN_PRESETS,
  chainPresetForEndpoint,
  DEFAULT_RPC_ENDPOINT,
  getRpcEndpoint,
  setRpcEndpoint,
} from "@/features/launchpad/lib/chainRpc";
import { getCachedRelayOrigin } from "@/shared/lib/mediaUrl";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { useQueryClient } from "@tanstack/react-query";

type RpcEndpointControlProps = {
  /** Called with the saved endpoint so siblings (e.g. WalletCard) can track it. */
  onEndpointSaved?: (endpoint: string) => void;
};

/**
 * Pick the chain launchpad reads are pointed at.
 *
 * Presets come from `CHAIN_PRESETS` in `lib/chainRpc.ts` — the same list the
 * web client renders. Per the Paperclip machine-values rule the label is plain
 * language and the chain id / RPC URL render in small mono type.
 *
 * Selecting a preset saves it immediately (one action = one durable persist);
 * the custom endpoint row stays for anything the presets do not cover.
 */
export function RpcEndpointControl({
  onEndpointSaved,
}: RpcEndpointControlProps) {
  const relayOrigin = getCachedRelayOrigin();
  const queryClient = useQueryClient();
  const [endpoint, setEndpoint] = React.useState(() =>
    getRpcEndpoint(relayOrigin),
  );
  const [open, setOpen] = React.useState(false);

  const active = chainPresetForEndpoint(endpoint);

  const save = (value: string) => {
    const saved = value.trim() || DEFAULT_RPC_ENDPOINT;
    setEndpoint(saved);
    setRpcEndpoint(relayOrigin, saved);
    onEndpointSaved?.(saved);
    setOpen(false);
    void queryClient.invalidateQueries({ queryKey: ["launchpad"] });
  };

  if (!open) {
    return (
      <button
        className="flex items-baseline gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-2xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        title={`Chain RPC: ${endpoint}`}
        type="button"
      >
        {active ? (
          <>
            <span>{active.label}</span>
            <span className="font-mono normal-case">{active.chainId}</span>
          </>
        ) : (
          <span className="font-mono normal-case">
            {endpoint.replace(/^https?:\/\//, "").slice(0, 18)}
          </span>
        )}
      </button>
    );
  }

  return (
    <fieldset
      className="flex min-w-0 flex-col gap-0.5 rounded-lg border border-border/70 bg-background p-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setEndpoint(getRpcEndpoint(relayOrigin));
          setOpen(false);
        }
      }}
    >
      <legend className="sr-only">Chain RPC endpoint</legend>
      {CHAIN_PRESETS.map((preset) => {
        const selected = active?.id === preset.id;
        return (
          <button
            aria-pressed={selected}
            className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            key={preset.id}
            onClick={() => save(preset.rpcUrl)}
            type="button"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-2xs text-foreground">{preset.label}</span>
              <span className="truncate font-mono text-3xs text-muted-foreground">
                {preset.rpcUrl}
              </span>
            </span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {preset.chainId}
            </span>
          </button>
        );
      })}
      <div className="mt-1 flex items-center gap-1 border-t border-border/60 pt-1">
        <label className="sr-only" htmlFor="launchpad-rpc">
          Custom RPC endpoint
        </label>
        <Input
          className="h-7 w-44 font-mono text-2xs"
          id="launchpad-rpc"
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder={DEFAULT_RPC_ENDPOINT}
          value={endpoint}
        />
        <Button
          onClick={() => save(endpoint)}
          size="sm"
          type="button"
          variant="outline"
        >
          Save
        </Button>
        <Button
          onClick={() => {
            setEndpoint(getRpcEndpoint(relayOrigin));
            setOpen(false);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Close
        </Button>
      </div>
    </fieldset>
  );
}
