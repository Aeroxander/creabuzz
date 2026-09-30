import { Check, Copy, Eye, EyeOff } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import {
  formatWalletAddress,
  parsePrivateKeyHexInput,
  type PrivateKeyParseReason,
  useChainStatusQuery,
  useWalletCreateMutation,
  useWalletImportMutation,
  useWalletStatusQuery,
} from "@/features/launchpad/walletHooks";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";

const COPY_RESET_MS = 1500;

const PRIVATE_KEY_PARSE_MESSAGES: Record<PrivateKeyParseReason, string> = {
  empty: "Paste a private key.",
  length: "Expected 64 hex characters.",
  charset: "Hex only — 0-9 and a-f.",
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

/**
 * Operator wallet surface: create/import, address display with copy, and
 * the connected chain id. This is a keyring-held dev/operator key — the
 * posture launch operations (deploy, graduation, mint) run from — NOT the
 * product's custody story, which is passkey-first on the web app where
 * bidders' funds live. v1 has no export or rotate — the key lives only in
 * the macOS Keychain. RPC failures and rejected commands surface inline.
 */
export function WalletCard({ rpcUrl }: { rpcUrl: string }) {
  const status = useWalletStatusQuery();
  const chain = useChainStatusQuery(rpcUrl);
  const createMutation = useWalletCreateMutation();
  const [importOpen, setImportOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copyResetTimer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(copyResetTimer.current), []);

  const address =
    status.data?.hasWallet && status.data.address ? status.data.address : null;

  const createErrorText = createMutation.isError
    ? errorMessage(createMutation.error, "Creating the wallet failed.")
    : null;
  const chainErrorText = chain.isError
    ? `Chain check failed: ${errorMessage(chain.error, "unknown error")}`
    : null;
  const noteError = createErrorText ?? chainErrorText;

  return (
    <fieldset
      aria-labelledby="launchpad-wallet-heading"
      className="w-80 rounded-2xl border border-border/70 bg-card/60 px-3 py-2"
      data-testid="launchpad-wallet-card"
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          className="text-2xs font-medium uppercase tracking-wide text-muted-foreground"
          id="launchpad-wallet-heading"
        >
          Operator wallet
        </h3>
        {chain.isLoading ? (
          <span className="text-2xs text-muted-foreground">
            checking chain…
          </span>
        ) : chain.isError ? (
          <span className="text-2xs text-destructive">chain unavailable</span>
        ) : chain.data ? (
          <span className="rounded-full bg-muted/70 px-2 py-0.5 text-2xs tabular-nums text-muted-foreground">
            chain {chain.data.chainId}
          </span>
        ) : null}
      </div>

      {/* Fixed floor so loading → loaded never shifts the card layout. */}
      <div className="mt-1 flex min-h-8 items-center gap-1.5">
        {status.isLoading ? (
          <>
            <Spinner aria-hidden="true" className="h-4 w-4" />
            <span className="text-xs text-muted-foreground">
              Checking wallet…
            </span>
          </>
        ) : status.isError ? (
          <>
            <span
              className="min-w-0 flex-1 truncate text-xs text-destructive"
              title={`Wallet status unavailable: ${errorMessage(status.error, "unknown error")}`}
            >
              {`Wallet status unavailable: ${errorMessage(status.error, "unknown error")}`}
            </span>
            <Button
              onClick={() => void status.refetch()}
              size="xs"
              type="button"
              variant="outline"
            >
              Retry
            </Button>
          </>
        ) : address ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs"
              data-testid="wallet-address"
              title={address}
            >
              {formatWalletAddress(address)}
            </span>
            <Button
              aria-label="Copy wallet address"
              onClick={() => {
                copyTextToClipboard(address, "Address copied");
                setCopied(true);
                window.clearTimeout(copyResetTimer.current);
                copyResetTimer.current = window.setTimeout(
                  () => setCopied(false),
                  COPY_RESET_MS,
                );
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
        ) : (
          <>
            <Button
              disabled={createMutation.isPending}
              onClick={() =>
                createMutation.mutate(undefined, {
                  onSuccess: () => toast.success("Wallet created."),
                })
              }
              size="sm"
              type="button"
            >
              {createMutation.isPending ? "Creating…" : "Create wallet"}
            </Button>
            <Button
              disabled={createMutation.isPending}
              onClick={() => setImportOpen(true)}
              size="sm"
              type="button"
              variant="outline"
            >
              Import private key
            </Button>
          </>
        )}
      </div>

      {noteError ? (
        <p className="mt-1 text-xs text-destructive">{noteError}</p>
      ) : (
        <p className="mt-1 text-2xs text-muted-foreground">
          {address
            ? "Operator key for launch operations (deploy, graduation, mint) — bidder funds use passkey custody on the web app. Stored in your macOS Keychain. Export and rotation aren't available in v1."
            : "Operator keys are stored in your macOS Keychain. Bidder funds use passkey custody on the web app."}
        </p>
      )}

      <ImportPrivateKeyDialog onOpenChange={setImportOpen} open={importOpen} />
    </fieldset>
  );
}

function ImportPrivateKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const importMutation = useWalletImportMutation();
  const [raw, setRaw] = React.useState("");
  const [reveal, setReveal] = React.useState(false);

  // Reset-on-open only; field edits must not be clobbered by re-renders.
  const wasOpen = React.useRef(open);
  const resetImport = importMutation.reset;
  React.useEffect(() => {
    const justOpened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!justOpened) return;
    setRaw("");
    setReveal(false);
    resetImport();
  }, [open, resetImport]);

  const parsed = parsePrivateKeyHexInput(raw);
  const parseError =
    raw.trim() === "" || parsed.ok
      ? null
      : PRIVATE_KEY_PARSE_MESSAGES[parsed.reason];
  const importErrorText = importMutation.isError
    ? errorMessage(importMutation.error, "Importing the private key failed.")
    : null;
  const errorText = parseError ?? importErrorText;

  const submit = () => {
    if (!parsed.ok || importMutation.isPending) return;
    importMutation.mutate(
      { privateKeyHex: parsed.privateKeyHex },
      {
        onSuccess: () => {
          toast.success("Private key imported.");
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next && importMutation.isPending) return;
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent aria-label="Import private key">
        <DialogHeader>
          <DialogTitle>Import private key</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-1 py-2">
          <label className="text-sm font-medium" htmlFor="wallet-import-key">
            Private key (hex)
          </label>
          <span className="flex items-center gap-1.5">
            <Input
              aria-describedby={
                errorText
                  ? "wallet-import-key-hint wallet-import-key-error"
                  : "wallet-import-key-hint"
              }
              autoComplete="off"
              id="wallet-import-key"
              onChange={(e) => setRaw(e.target.value)}
              placeholder="64 hex characters"
              spellCheck={false}
              type={reveal ? "text" : "password"}
              value={raw}
            />
            <Button
              aria-label={reveal ? "Hide private key" : "Reveal private key"}
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
              size="icon"
              type="button"
              variant="outline"
            >
              {reveal ? <EyeOff /> : <Eye />}
            </Button>
          </span>
          <p
            className="text-2xs text-muted-foreground"
            id="wallet-import-key-hint"
          >
            64 hex characters (an optional 0x prefix is accepted). Stored in
            your macOS Keychain.
          </p>
          {errorText ? (
            <p
              className="text-xs text-destructive"
              id="wallet-import-key-error"
            >
              {errorText}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={importMutation.isPending}
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={!parsed.ok || importMutation.isPending}
            onClick={submit}
            size="sm"
            type="button"
          >
            {importMutation.isPending ? "Importing…" : "Import private key"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
