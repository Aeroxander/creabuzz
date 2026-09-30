/**
 * Deployment records — kind:37018, the Summoner's onchain footprint.
 *
 * Record contract (the relay-side producer publishes exactly this):
 *
 * ```
 * kind 37018, d = "<chainId>:<role>"
 * tags: ["chain", id], ["role", "summoner" | "factory" | "implementation"],
 *       ["address", "0x…"], ["tx", …]
 * content: { v, block, project, note }
 * ```
 *
 * What the Discover directory uses it for: knowing which projects the
 * Summoner has actually deployed (`content.project` links a record to a
 * project id), which chain they live on, and where the deployment tx can be
 * read. A deployment record is **never** proof of a DAO address — the three
 * roles are infrastructure (`summoner` = the majeur CREATE2 factory,
 * `factory` = the summon-and-bind entry point, `implementation` = the Moloch
 * the Summoner clones), so the `address` tag documents a *contract*. A card
 * built from one prints that address labelled as the contract it is, never
 * as a treasury; DAO addresses come from kind:47005 summon receipts only.
 *
 * Refusal rule (the whole repo's stance): anything the wire contract in
 * `crates/buzz-core/src/kind.rs` marks required and that does not hold —
 * an unparseable `d`, a chain id that disagrees with its tag, an address or
 * tx that is not one, an unknown role → null, and the caller counts it
 * (`malformed`, never silently dropped). An absent or malformed optional
 * `project` is carried as `null`, which the caller counts as `unlinked`.
 */
import type { NostrEvent } from "@/shared/lib/nostr-client";

/** The deployment record kind. Mirrors `crates/buzz-core/src/kind.rs`. */
export const KIND_DEPLOYMENT = 37018;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
const CHAIN_RE = /^\d{1,20}$/;
/** The contract's role vocabulary — anything else is not a 37018 record. */
const ROLE_RE = /^(summoner|factory|implementation)$/;
/** `content.project` — `<slug>`, exactly as `kind.rs` spells it. */
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One parsed kind:37018 deployment. */
export interface DeploymentRecord {
  eventId: string;
  chainId: string;
  /** `summoner` | `factory` | `implementation` (or a producer extension). */
  role: string;
  /** The deployed contract's address (tag `address`, lowercased). */
  address: string;
  /** The deploying tx — required by the contract, `0x` + 64 hex. */
  tx: string;
  block: number | null;
  /** `content.project` — the project id this deployment belongs to. */
  project: string | null;
  note: string | null;
  createdAt: number;
}

function contentObject(event: NostrEvent): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function tagValue(event: NostrEvent, name: string): string | null {
  const tag = event.tags.find((t) => t[0] === name);
  return tag && tag.length >= 2 && tag[1] ? tag[1] : null;
}

/** `"<chainId>:<role>"` — the d tag, when it parses. */
function splitCoordinate(d: string): {
  chainId: string | null;
  role: string | null;
} {
  const at = d.indexOf(":");
  if (at <= 0 || at === d.length - 1) return { chainId: null, role: null };
  const chainId = d.slice(0, at);
  const role = d.slice(at + 1);
  if (!CHAIN_RE.test(chainId) || !ROLE_RE.test(role)) {
    return { chainId: null, role: null };
  }
  return { chainId, role };
}

/**
 * Parse one kind:37018 record, or null when it cannot be trusted. The `d`
 * coordinate and the `chain`/`role` tags must agree when both are present —
 * a disagreement is refused, not arbitrated.
 */
export function parseDeployment(event: NostrEvent): DeploymentRecord | null {
  if (event.kind !== KIND_DEPLOYMENT) return null;
  const d = tagValue(event, "d");
  if (!d) return null;
  // `d` is the NIP-33 coordinate: if it does not say `<chainId>:<role>` the
  // record is not addressable as the contract specifies — refuse it rather
  // than fall back to tags it may disagree with.
  const coord = splitCoordinate(d);
  if (!coord.chainId || !coord.role) return null;
  const chainTag = tagValue(event, "chain");
  const roleTag = tagValue(event, "role");
  const chainId =
    chainTag && CHAIN_RE.test(chainTag) ? chainTag : coord.chainId;
  const role = roleTag && ROLE_RE.test(roleTag) ? roleTag : coord.role;
  if (!chainId || !role) return null;
  if (chainTag && chainTag !== coord.chainId) return null;
  if (roleTag && roleTag !== coord.role) return null;

  const addressTag = tagValue(event, "address");
  if (!addressTag || !ADDRESS_RE.test(addressTag)) return null;
  // Required by the contract so a reader can verify the deployment on chain:
  // a record without it is refused, never shown half-verified.
  const tx = tagValue(event, "tx");
  if (!tx || !TX_RE.test(tx)) return null;

  const body = contentObject(event);
  if (!body) return null;

  return {
    eventId: event.id,
    chainId,
    role,
    address: addressTag.toLowerCase(),
    tx,
    block:
      typeof body.block === "number" && Number.isSafeInteger(body.block)
        ? body.block
        : null,
    // An unusable slug is carried as `null`: the record stays readable and
    // the caller counts it as unplaced instead of dropping the row.
    project:
      typeof body.project === "string" && PROJECT_RE.test(body.project)
        ? body.project
        : null,
    note: typeof body.note === "string" && body.note ? body.note : null,
    createdAt: event.created_at,
  };
}
