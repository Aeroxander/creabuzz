import * as React from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  KeyRound,
  Trash2,
} from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { PubKey } from "@/shared/ui/PubKey";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/ui/sheet";

import { useRevokeOrgGrantMutation } from "../hooks";
import { isGrantExpired } from "../lib/grantCurtain";
import { verbEntailedBy } from "../lib/grantVerify";
import type { OrgGrant, OrgNode } from "../orgModels";

const MAX_PARENT_CHAIN_DEPTH = 32;

function identityLabel(
  pubkey: string,
  profiles: Record<string, { displayName: string | null } | undefined>,
): string {
  if (!pubkey) return "unknown signer";
  return profiles[pubkey.toLowerCase()]?.displayName ?? truncatePubkey(pubkey);
}

/** One verb row with its entailment state (valid / violation). */
function VerbEntailmentRow({
  verb,
  valid,
  parentScoped,
}: {
  verb: string;
  valid: boolean;
  parentScoped: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
      <span className="font-mono text-xs text-foreground">{verb}</span>
      {valid ? (
        <span
          className="inline-flex items-center gap-1 text-xs text-status-ok"
          title={
            parentScoped
              ? "Entailed by the parent grant"
              : "Covered by the via node\u2019s canGrant standing"
          }
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">valid</span>
          valid
        </span>
      ) : (
        <span
          className="inline-flex items-center gap-1 text-xs text-destructive"
          title={
            parentScoped
              ? "Not entailed by any parent verb"
              : "Not covered by the via node\u2019s canGrant standing"
          }
        >
          <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">violation</span>
          violation
        </span>
      )}
    </li>
  );
}

/** Parent chain as a mini vertical chain, root first. */
function ParentChain({
  grant,
  grantsByDtag,
  now,
}: {
  grant: OrgGrant;
  grantsByDtag: Map<string, OrgGrant>;
  now: number;
}) {
  const chain: OrgGrant[] = [grant];
  let current = grant;
  const seen = new Set<string>([grant.dtag]);
  while (
    current.parentGrant &&
    current.parentGrant !== current.dtag &&
    !seen.has(current.parentGrant) &&
    chain.length <= MAX_PARENT_CHAIN_DEPTH
  ) {
    const parent = grantsByDtag.get(current.parentGrant);
    if (!parent) break;
    seen.add(parent.dtag);
    chain.push(parent);
    current = parent;
  }
  const rootFirst = [...chain].reverse();
  return (
    <div>
      <p className="text-xs font-medium text-foreground">Parent chain</p>
      <ol className="mt-1.5 space-y-0">
        {rootFirst.map((link, index) => {
          const dead = link.revoked || isGrantExpired(link, now);
          const isLast = index === rootFirst.length - 1;
          return (
            <li
              className="relative flex items-start gap-2 pb-1"
              key={link.dtag}
            >
              {!isLast && (
                <span
                  aria-hidden="true"
                  className="absolute left-[7px] top-4 h-[calc(100%-10px)] w-px bg-border"
                />
              )}
              <span
                aria-hidden="true"
                className="mt-1 h-3.5 w-3.5 shrink-0 rounded-full border border-border bg-background"
              />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 font-mono text-2xs text-foreground">
                  {link.dtag}
                  {dead && (
                    <Badge variant="secondary">
                      {link.revoked ? "revoked" : "expired"}
                    </Badge>
                  )}
                </p>
                <p className="mt-0.5 truncate text-2xs text-muted-foreground">
                  {link.verbs.join(", ") || "no verbs"} →{" "}
                  {link.grantee ? truncatePubkey(link.grantee) : "unknown"}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type OrgGrantDetailSheetProps = {
  grant: OrgGrant;
  /** All grants (active + curtain) so parent chains stay resolvable. */
  grants: OrgGrant[];
  nodes: OrgNode[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function OrgGrantDetailSheet({
  grant,
  grants,
  nodes,
  open,
  onOpenChange,
}: OrgGrantDetailSheetProps) {
  const revokeMutation = useRevokeOrgGrantMutation();
  const [revokeError, setRevokeError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const copyResetTimer = React.useRef<number | undefined>(undefined);
  const seenGrantDtagRef = React.useRef<string | null>(null);
  React.useEffect(() => () => window.clearTimeout(copyResetTimer.current), []);
  // Reset the inline revoke error whenever the drawer opens onto a new grant
  // (the ref keeps the reset on the grant change, not on re-renders).
  React.useEffect(() => {
    if (open && seenGrantDtagRef.current !== grant.dtag) {
      seenGrantDtagRef.current = grant.dtag;
      setRevokeError(null);
    }
  }, [open, grant.dtag]);

  const now = Math.floor(Date.now() / 1000);
  const grantsByDtag = React.useMemo(
    () => new Map(grants.map((g) => [g.dtag, g])),
    [grants],
  );
  const parent = grant.parentGrant
    ? grantsByDtag.get(grant.parentGrant)
    : undefined;
  const viaNode = nodes.find((node) => node.dtag === grant.via);
  const expiredNow = isGrantExpired(grant, now);
  const revoked = grant.revoked;
  const parentScoped = parent !== undefined;

  const profilesQuery = useUsersBatchQuery(
    React.useMemo(
      () => [grant.issuer, grant.grantee].filter((pubkey) => pubkey.length > 0),
      [grant.issuer, grant.grantee],
    ),
  );
  const profiles = profilesQuery.data?.profiles ?? {};

  const verbValid = (verb: string) => {
    if (parentScoped && parent) {
      return parent.verbs.some((pv) => verbEntailedBy(verb, pv));
    }
    return (
      viaNode?.scope.canGrant.some((standing) =>
        verbEntailedBy(verb, standing),
      ) ?? false
    );
  };

  const copyId = () => {
    copyTextToClipboard(grant.dtag, "Grant ID copied");
    setCopied(true);
    window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const handleRevoke = () => {
    setRevokeError(null);
    void (async () => {
      try {
        await revokeMutation.mutateAsync(grant.dtag);
        // The refetched grant lands in the curtain; close so the caller’s
        // re-render shows the shelf without a stale drawer.
        onOpenChange(false);
      } catch (error) {
        setRevokeError(
          error instanceof Error
            ? error.message
            : "Failed to revoke grant. The relay did not accept the revocation.",
        );
      }
    })();
  };

  const label = grant.verbs.join(", ") || grant.dtag;

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-1.5">
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            Grant {grant.dtag}
          </SheetTitle>
          <SheetDescription>
            Delegation detail, attenuation state, and revocation history.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Identities */}
          <div className="space-y-2">
            <IdentityRow
              label="Issuer"
              profiles={profiles}
              pubkey={grant.issuer}
            />
            <IdentityRow
              label="Grantee"
              profiles={profiles}
              pubkey={grant.grantee}
            />
          </div>

          {/* Via node */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-foreground">Via node</p>
            <p className="rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs">
              {viaNode ? `${viaNode.name} (` : "("}
              {grant.via || "none"}
              {viaNode ? ")" : " — node not found)"}
            </p>
          </div>

          {/* Verbs with entailment state */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">Verbs</p>
              {parent ? (
                <p className="text-2xs text-muted-foreground">
                  entailed by {parent.dtag}
                </p>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  root grant · standing from {grant.via || "via node"}
                </p>
              )}
            </div>
            {grant.verbs.length > 0 ? (
              <ul className="space-y-1">
                {grant.verbs.map((verb) => (
                  <VerbEntailmentRow
                    key={verb}
                    parentScoped={parentScoped}
                    valid={verbValid(verb)}
                    verb={verb}
                  />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">no verbs</p>
            )}
          </div>

          {/* Expiry */}
          <div className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1.5">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock aria-hidden="true" className="h-3.5 w-3.5" />
              {grant.expires !== undefined
                ? `Expires ${new Date(grant.expires * 1000).toLocaleDateString()}`
                : "No expiry"}
            </span>
            {expiredNow && <Badge variant="warning">expired</Badge>}
            {revoked && <Badge variant="secondary">revoked</Badge>}
          </div>

          {/* Parent chain */}
          {grant.parentGrant && (
            <ParentChain grant={grant} grantsByDtag={grantsByDtag} now={now} />
          )}

          {/* Revoke */}
          <div className="space-y-2 border-t pt-3">
            {(revoked || expiredNow) && !revoked && (
              <p className="text-xs text-muted-foreground">
                This grant is past its expiry — it can no longer be used. It
                stays listed in the revoked &amp; expired history.
              </p>
            )}
            {revoked && (
              <p className="text-xs text-muted-foreground">
                This grant was revoked. Revocation history stays visible in the
                revoked &amp; expired shelf.
              </p>
            )}
            {!revoked && !expiredNow && (
              <>
                <Button
                  className="w-full"
                  disabled={revokeMutation.isPending}
                  onClick={handleRevoke}
                  variant="destructive"
                >
                  <Trash2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {revokeMutation.isPending ? "Revoking…" : "Revoke grant"}
                </Button>
                {revokeError && (
                  <div
                    className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2"
                    data-testid="org-grant-revoke-error"
                    role="alert"
                  >
                    <p className="min-w-0 text-sm text-destructive">
                      {revokeError}
                    </p>
                    <Button
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={revokeMutation.isPending}
                      onClick={handleRevoke}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Retry
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="text-2xs text-muted-foreground">
            <Button
              aria-label={`Copy grant ID ${label}`}
              className="h-6 px-2 text-xs"
              onClick={copyId}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Copy aria-hidden="true" className="mr-1 h-3 w-3" />
              {copied ? "Copied" : "Copy ID"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function IdentityRow({
  label,
  pubkey,
  profiles,
}: {
  label: string;
  pubkey: string;
  profiles: Record<string, { displayName: string | null } | undefined>;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        {pubkey ? (
          <>
            <PubKey pubkey={pubkey} interactive={true} className="text-xs" />
            <span className="truncate text-2xs text-muted-foreground">
              {identityLabel(pubkey, profiles)}
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">unknown</span>
        )}
      </span>
    </div>
  );
}
