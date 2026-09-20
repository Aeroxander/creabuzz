import * as React from "react";
import {
  ChevronDown,
  ChevronRight,
  Clock,
  AlertTriangle,
  Check,
  MoreHorizontal,
  Trash2,
  Copy,
  KeyRound,
} from "lucide-react";

import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { PubKey } from "@/shared/ui/PubKey";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { useRevokeOrgGrantMutation } from "../hooks";
import { buildGrantTree, type GrantTreeNode } from "../lib/tree";
import { verbEntailedBy } from "../lib/grantVerify";
import type { OrgGrant } from "../orgModels";

type OrgGrantChainViewProps = {
  grants: OrgGrant[];
};

function VerbBadge({ verb }: { verb: string }) {
  return (
    <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground">
      {verb}
    </span>
  );
}

/**
 * Attenuation indicator for one delegation link: every child verb must be
 * entailed by some parent verb (same rule as the relay-side verifier).
 */
function AttenuationIndicator({
  grant,
  grantsByDtag,
}: {
  grant: OrgGrant;
  grantsByDtag: Map<string, OrgGrant>;
}) {
  const parent = grant.parentGrant
    ? grantsByDtag.get(grant.parentGrant)
    : undefined;
  if (!parent) return null;
  const violating = grant.verbs.filter(
    (verb) => !parent.verbs.some((pv) => verbEntailedBy(verb, pv)),
  );
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
}: {
  treeNode: GrantTreeNode;
  grantsByDtag: Map<string, OrgGrant>;
}) {
  const [expanded, setExpanded] = React.useState(true);
  const revokeMutation = useRevokeOrgGrantMutation();
  const [copied, setCopied] = React.useState(false);
  const copyResetTimer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(copyResetTimer.current), []);

  const grant = treeNode.grant;
  const hasChildren = treeNode.children.length > 0;
  const isRoot = treeNode.depth === 0;
  const label = grant.verbs.join(", ") || grant.dtag;

  const copyId = () => {
    copyTextToClipboard(grant.dtag, "Grant ID copied");
    setCopied(true);
    window.clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

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
            className="h-4 w-4 shrink-0 text-muted-foreground hover:text-foreground"
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

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            {grant.verbs.length > 0 ? (
              grant.verbs.map((verb) => <VerbBadge key={verb} verb={verb} />)
            ) : (
              <span className="text-2xs text-muted-foreground">no verbs</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
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
          </div>
        </div>

        <AttenuationIndicator grant={grant} grantsByDtag={grantsByDtag} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={`Grant actions for ${label}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted group-hover:opacity-100"
              type="button"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={copyId}>
              <Copy className="mr-2 h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy ID"}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => revokeMutation.mutate(grant.dtag)}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Revoke
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expanded &&
        hasChildren &&
        treeNode.children.map((child) => (
          <GrantChainRow
            key={child.grant.dtag}
            grantsByDtag={grantsByDtag}
            treeNode={child}
          />
        ))}
    </div>
  );
}

/**
 * Hierarchical view of the kind:37011 delegation forest (parentGrant links),
 * with per-link attenuation indicators and revoke/copy actions.
 */
export function OrgGrantChainView({ grants }: OrgGrantChainViewProps) {
  const activeGrants = React.useMemo(
    () => grants.filter((g) => !g.revoked),
    [grants],
  );
  const roots = React.useMemo(
    () => buildGrantTree(activeGrants),
    [activeGrants],
  );
  const grantsByDtag = React.useMemo(
    () => new Map(activeGrants.map((g) => [g.dtag, g])),
    [activeGrants],
  );

  if (roots.length === 0) return null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Delegations</h3>
      <div className="space-y-0.5">
        {roots.map((treeNode) => (
          <GrantChainRow
            key={treeNode.grant.dtag}
            grantsByDtag={grantsByDtag}
            treeNode={treeNode}
          />
        ))}
      </div>
    </div>
  );
}
