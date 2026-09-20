import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  KeyRound,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { PubKey } from "@/shared/ui/PubKey";

import {
  groupGrantsByLifecycle,
  type CurtainReason,
} from "../lib/grantCurtain";
import { verbEntailedBy } from "../lib/grantVerify";
import { buildGrantTree, type GrantTreeNode } from "../lib/tree";
import type { OrgGrant, OrgNode } from "../orgModels";
import { OrgGrantDetailSheet } from "./OrgGrantDetailSheet";

type OrgGrantChainViewProps = {
  grants: OrgGrant[];
  /** Needed to resolve `via` node names in the drawer and root standing. */
  nodes: OrgNode[];
};

/**
 * Hierarchical view of the kind:37011 delegation forest, split by lifecycle:
 * the active chain (parentGrant links, attenuation indicators, revoke) plus a
 * collapsible "Revoked &amp; expired" curtain shelf at the bottom. Revoked and
 * expired grants never disappear — revocation and expiry are always visible
 * history (P2 item 11). Every row opens a detail Sheet; the shelf only exists
 * when there is history to show.
 */
export function OrgGrantChainView({ grants, nodes }: OrgGrantChainViewProps) {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 1000));
  // Keep the expired grouping truthful while the view sits open.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Math.floor(Date.now() / 1000));
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const { active, curtain } = React.useMemo(
    () => groupGrantsByLifecycle(grants, now),
    [grants, now],
  );
  const roots = React.useMemo(() => buildGrantTree(active), [active]);
  const [openDtag, setOpenDtag] = React.useState<string | null>(null);
  const openGrant = React.useMemo(
    () => grants.find((grant) => grant.dtag === openDtag) ?? null,
    [grants, openDtag],
  );

  if (roots.length === 0 && curtain.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Delegations</h3>
      {roots.length === 0 && curtain.length > 0 && (
        <p className="mb-2 text-xs text-muted-foreground">
          No grants in force — the history below is the full record.
        </p>
      )}
      {roots.length > 0 && (
        <div className="space-y-0.5">
          {roots.map((treeNode) => (
            <GrantChainRow
              grantsByDtag={new Map(active.map((grant) => [grant.dtag, grant]))}
              key={treeNode.grant.dtag}
              nodes={nodes}
              onOpen={setOpenDtag}
              treeNode={treeNode}
            />
          ))}
        </div>
      )}
      {curtain.length > 0 && (
        <CurtainShelf entries={curtain} onOpen={setOpenDtag} />
      )}
      {openGrant && (
        <OrgGrantDetailSheet
          grant={openGrant}
          grants={grants}
          nodes={nodes}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setOpenDtag(null);
          }}
          open={openGrant !== null}
        />
      )}
    </div>
  );
}

function VerbBadge({ verb }: { verb: string }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground">
      {verb}
    </span>
  );
}

/**
 * Per-link attenuation indicator (relay-side rule, client mirror): every
 * child verb must be entailed by some parent verb; root verbs by the via
 * node's canGrant standing. Reuses the exact sr-only survey text the chart
 * spec asserts so the read model and the drawer agree on state.
 */
function AttenuationIndicator({
  grant,
  grantsByDtag,
  viaNodeScope,
}: {
  grant: OrgGrant;
  grantsByDtag: Map<string, OrgGrant>;
  viaNodeScope?: OrgNode["scope"];
}) {
  const parent = grant.parentGrant
    ? grantsByDtag.get(grant.parentGrant)
    : undefined;
  const valid = (verb: string) => {
    if (parent) {
      return parent.verbs.some((pv) => verbEntailedBy(verb, pv));
    }
    return (
      viaNodeScope?.canGrant.some((standing) =>
        verbEntailedBy(verb, standing),
      ) ?? false
    );
  };
  const violating = grant.verbs.filter((verb) => !valid(verb));
  if (violating.length === 0) {
    return (
      <span
        className="inline-flex shrink-0 items-center text-emerald-600 dark:text-emerald-400"
        title="Every verb is entailed by the parent grant"
      >
        <Check aria-hidden="true" className="h-3.5 w-3.5" />
        <span className="sr-only">Attenuation valid</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex shrink-0 items-center text-destructive"
      title={`Not entailed by parent grant: ${violating.join(", ")}`}
    >
      <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="sr-only">
        {`Attenuation violation: ${violating.join(", ")}`}
      </span>
    </span>
  );
}

function GrantChainRow({
  treeNode,
  grantsByDtag,
  nodes,
  onOpen,
}: {
  treeNode: GrantTreeNode;
  grantsByDtag: Map<string, OrgGrant>;
  nodes: OrgNode[];
  onOpen: (dtag: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const grant = treeNode.grant;
  const hasChildren = treeNode.children.length > 0;
  const isRoot = treeNode.depth === 0;
  const label = grant.verbs.join(", ") || grant.dtag;

  return (
    <div>
      <div
        className={`group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 ${
          isRoot ? "border-l-2" : "border-l-2 border-dashed"
        }`}
        style={{ paddingLeft: `${treeNode.depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span aria-hidden="true" className="block h-3.5 w-3.5 shrink-0" />
        )}

        <KeyRound
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />

        {/* Row body: opens the detail sheet (the drawer owns Revoke/Copy). */}
        <button
          aria-label={`Open grant ${label}`}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onOpen(grant.dtag)}
          type="button"
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {grant.verbs.length > 0 ? (
              grant.verbs.map((verb) => <VerbBadge key={verb} verb={verb} />)
            ) : (
              <span className="text-2xs text-muted-foreground">no verbs</span>
            )}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              to{" "}
              <PubKey
                pubkey={grant.grantee}
                interactive={false}
                className="text-xs"
              />
            </span>
            {grant.expires !== undefined && (
              <span className="inline-flex items-center gap-0.5">
                <Clock aria-hidden="true" className="h-3 w-3" />
                expires {new Date(grant.expires * 1000).toLocaleDateString()}
              </span>
            )}
          </span>
          <AttenuationIndicator
            grant={grant}
            grantsByDtag={grantsByDtag}
            viaNodeScope={nodes.find((node) => node.dtag === grant.via)?.scope}
          />
          <ChevronRight
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          />
        </button>
      </div>

      {expanded &&
        hasChildren &&
        treeNode.children.map((child) => (
          <GrantChainRow
            grantsByDtag={grantsByDtag}
            key={child.grant.dtag}
            nodes={nodes}
            onOpen={onOpen}
            treeNode={child}
          />
        ))}
    </div>
  );
}

function CurtainShelf({
  entries,
  onOpen,
}: {
  entries: Array<{ grant: OrgGrant; reason: CurtainReason }>;
  onOpen: (dtag: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const count = entries.length;
  return (
    <div className="mt-2">
      <button
        aria-controls="org-curtain-history"
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/50"
        data-testid="org-curtain-toggle"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        Revoked &amp; expired
        <Badge data-testid="org-curtain-count" variant="secondary">
          {count}
        </Badge>
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5" id="org-curtain-history">
          {entries.map(({ grant, reason }) => (
            <CurtainRow
              grant={grant}
              key={grant.dtag}
              onOpen={onOpen}
              reason={reason}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CurtainRow({
  grant,
  reason,
  onOpen,
}: {
  grant: OrgGrant;
  reason: CurtainReason;
  onOpen: (dtag: string) => void;
}) {
  const label = grant.verbs.join(", ") || grant.dtag;
  const endedAt = reason === "revoked" ? "revoked" : "expired";
  return (
    <div
      className="group flex items-center gap-2 rounded-md border-l-2 border-dashed px-2 py-1.5 opacity-80 hover:bg-muted/50"
      data-testid="org-curtain-row"
      style={{ paddingLeft: "12px" }}
    >
      <span
        aria-hidden="true"
        className="block h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
      >
        <KeyRound className="h-3.5 w-3.5" />
      </span>
      <button
        aria-label={`Open revoked or expired grant ${label}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={() => onOpen(grant.dtag)}
        type="button"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {grant.verbs.length > 0 ? (
            grant.verbs.map((verb) => <VerbBadge key={verb} verb={verb} />)
          ) : (
            <span className="text-2xs text-muted-foreground">no verbs</span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1">
            to{" "}
            <PubKey
              pubkey={grant.grantee}
              interactive={false}
              className="text-xs"
            />
          </span>
          <Badge variant={reason === "revoked" ? "secondary" : "warning"}>
            {endedAt}
          </Badge>
          <span className="text-2xs">
            {new Date(grant.createdAt * 1000).toLocaleDateString()}
          </span>
        </span>
        <ChevronRight
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      </button>
    </div>
  );
}
