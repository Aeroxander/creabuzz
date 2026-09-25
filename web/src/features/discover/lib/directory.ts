/**
 * The Discover directory — one bounded snapshot of the relay, derived into
 * three scannable sections.
 *
 * The stance (docs/paperclip-ux-reference.md §1) is that the interface must
 * answer, in this order: *what is happening → does it need me → what do I do
 * about it*. This module is the derivation that makes those three answers
 * possible from records alone:
 *
 * | Section        | Record sources                                        |
 * | -------------- | ----------------------------------------------------- |
 * | DAOs           | kind:47005 `table:"summon"` receipts (the dao address, |
 * |                | the seats minted, the summon tx) + kind:37018          |
 * |                | deployment records (the Summoner's known deployments:   |
 * |                | project link, chain, contract address, tx)             |
 * | Live launches  | kind:37001 launch records (+ their 47005 receipts for  |
 * |                | the stage); a draft is not a live launch               |
 * | Open projects  | kind:37015 pitches through `deriveBoard` — the equity  |
 * |                | map that already answers "team size" and "open roles"  |
 *
 * Every row that fails to parse is **counted, not dropped**
 * (`trust-signals.ts:37` convention): `counts` reach the page as a line above
 * the cards, so "12 things listed" can never quietly mean "12 of 15 things
 * listed". Nothing here performs network or chain I/O — `use-discover.ts`
 * fetches, this file only derives, so every rule above is testable without a
 * relay (`directory.test.mjs`).
 */
import type { NostrEvent } from "@/shared/lib/nostr-client";

import {
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_RECEIPT,
  KIND_ORG_GRANT,
  KIND_ORG_JOIN_REQUEST,
  KIND_ORG_NODE,
  KIND_ORG_PITCH,
} from "../../../shared/constants/kinds.ts";
import { formatMoney } from "../../launchpad/lib/amounts.ts";
import {
  explorerAddressUrl,
  explorerTxUrl,
} from "../../launchpad/lib/fund-flow.ts";
import {
  buildLaunches,
  effectiveStage,
  parseLaunchRecord,
  parseLaunchReceipt,
  type Launch,
  type LaunchReceipt,
  type LaunchStage,
} from "../../launchpad/models.ts";
import {
  parseJoinRequest,
  type JoinRequest,
} from "../../projects/lib/join-request.ts";
import {
  parseOwnershipGrant,
  type OwnershipGrant,
} from "../../projects/lib/grant.ts";
import {
  parsePitch,
  type PitchManifest,
  type RoleDeclaration,
} from "../../projects/lib/manifest.ts";
import { deriveBoard, type ProjectSummary } from "../../projects/lib/state.ts";
import {
  KIND_DEPLOYMENT,
  parseDeployment,
  type DeploymentRecord,
} from "./deployments.ts";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** NIP-01 deletion event — its `#a` tags name the tombstoned coordinates. */
const KIND_TOMBSTONE = 5;

/**
 * The one query the directory issues: explicit kinds, no wildcards, so the
 * p-gate cannot reject it and the scan stays bounded to this feature's rows.
 * Kind 5 comes along so a launch deleted from the launchpad cannot still be
 * listed here (`use-launches.ts:57` reads the same set for the same reason).
 */
export const DISCOVER_EVENT_KINDS = [
  KIND_TOMBSTONE,
  KIND_LAUNCH_RECORD,
  KIND_LAUNCH_RECEIPT,
  KIND_ORG_NODE,
  KIND_ORG_GRANT,
  KIND_ORG_PITCH,
  KIND_ORG_JOIN_REQUEST,
  KIND_DEPLOYMENT,
] as const;

/** What could not be listed, and why — surfaced verbatim on the page. */
export interface DirectoryCounts {
  /** Rows that failed to parse: counted, never dropped. */
  malformed: number;
  /** Deployment records with no `content.project` — valid, but unplaceable. */
  unlinked: number;
  /** Summon receipts whose launch record is absent from this snapshot. */
  orphanReceipts: number;
}

/** One DAO card: the money layer, with the provenance of every figure. */
export interface DaoCard {
  /** One DAO per project id — receipts and deployments merge onto it. */
  projectId: string;
  /** Pitch name, else launch name, else the project id (never invented). */
  name: string;
  /** The DAO address when a record proves one (`payload.dao` / `content.dao`). */
  dao: string | null;
  /**
   * What the card shows when `dao` is null: the address a deployment record
   * published *for its role* — labelled as a contract, never as a treasury.
   */
  contract: { role: string; address: string } | null;
  chainId: number | null;
  /** Explorer link for whichever address is shown; null = unknown chain. */
  addressUrl: string | null;
  /** Explorer link for the summon tx, else the deployment tx. */
  txUrl: string | null;
  summonTx: string | null;
  deploymentTx: string | null;
  /** Team size from the project's equity map — `null` when no pitch exists. */
  teamSize: number | null;
  teamSource: "equity-map" | "summon-receipt" | null;
  /** Seats the summon receipt minted, when there is a receipt. */
  mintedSeats: number | null;
  founder: string | null;
  hasPitch: boolean;
  openRoles: RoleDeclaration[];
  updatedAt: number;
  /** Human provenance, printed on the card: which records built it. */
  sources: string[];
}

export interface DirectorySnapshot {
  /** Newest activity first. */
  daos: DaoCard[];
  /** Non-draft launches, newest record first. */
  launches: Launch[];
  /** The project board's own cards (`deriveBoard`). */
  projects: ProjectSummary[];
  counts: DirectoryCounts;
}

/** The filter chips above the sections. */
export type DiscoverFilter = "all" | "daos" | "fundraising" | "hiring";

export interface SectionVisibility {
  daos: boolean;
  launches: boolean;
  projects: boolean;
}

/**
 * Which sections a chip shows. Table-tested exhaustively — a chip that
 * silently showed a second section would make the counts lie.
 */
export function visibleSections(filter: DiscoverFilter): SectionVisibility {
  return {
    daos: filter === "all" || filter === "daos",
    launches: filter === "all" || filter === "fundraising",
    projects: filter === "all" || filter === "hiring",
  };
}

/** The `summon` receipt payload — validated field by field (org-money.ts). */
interface SummonPayload {
  dao: string | null;
  project: string | null;
  chainId: string | null;
  holders: number | null;
}

function summonPayload(receipt: LaunchReceipt): SummonPayload {
  const body = receipt.payload as Record<string, unknown>;
  const dao =
    typeof body.dao === "string" && ADDRESS_RE.test(body.dao)
      ? body.dao.toLowerCase()
      : null;
  const project =
    typeof body.project === "string" && body.project ? body.project : null;
  const chain =
    typeof body.chain === "string" && body.chain
      ? body.chain
      : typeof body.chain === "number"
        ? String(body.chain)
        : null;
  const holders = Array.isArray(body.holders) ? body.holders.length : null;
  return { dao, project, chainId: chain, holders };
}

function toChainNumber(value: string | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const chainId = Number(value);
  return Number.isSafeInteger(chainId) ? chainId : null;
}

function tombstonedCoordinate(event: NostrEvent): string | null {
  const a = event.tags.find((tag) => tag[0] === "a" && tag[1]);
  return a ? a[1] : null;
}

/**
 * Derive the whole directory from one snapshot of events.
 *
 * Malformed rows are counted (never dropped), receipts and deployments merge
 * onto a single card per project, and each card states the source of every
 * figure it prints — the seam `directory.test.mjs` binds to.
 */
export function deriveDirectory(input: {
  events: readonly NostrEvent[];
  me?: string | null;
}): DirectorySnapshot {
  const events = [...input.events];
  const counts: DirectoryCounts = {
    malformed: 0,
    unlinked: 0,
    orphanReceipts: 0,
  };

  const tombstones = new Set<string>();
  const receipts: LaunchReceipt[] = [];
  const deployments: DeploymentRecord[] = [];
  const pitches: PitchManifest[] = [];
  const nodes: NostrEvent[] = [];
  const requests: JoinRequest[] = [];
  const grants: OwnershipGrant[] = [];

  for (const event of events) {
    switch (event.kind) {
      case KIND_TOMBSTONE: {
        const coordinate = tombstonedCoordinate(event);
        if (coordinate) tombstones.add(coordinate);
        break;
      }
      case KIND_LAUNCH_RECORD: {
        if (!parseLaunchRecord(event)) counts.malformed += 1;
        break;
      }
      case KIND_LAUNCH_RECEIPT: {
        const receipt = parseLaunchReceipt(event);
        if (receipt) receipts.push(receipt);
        else counts.malformed += 1;
        break;
      }
      case KIND_ORG_PITCH: {
        const pitch = parsePitch(event);
        if (pitch) pitches.push(pitch);
        else counts.malformed += 1;
        break;
      }
      case KIND_ORG_JOIN_REQUEST: {
        const request = parseJoinRequest(event);
        if (request) requests.push(request);
        else counts.malformed += 1;
        break;
      }
      case KIND_ORG_GRANT: {
        const grant = parseOwnershipGrant(event);
        if (grant) grants.push(grant);
        else counts.malformed += 1;
        break;
      }
      case KIND_ORG_NODE: {
        nodes.push(event);
        break;
      }
      case KIND_DEPLOYMENT: {
        const deployment = parseDeployment(event);
        if (!deployment) counts.malformed += 1;
        else if (deployment.project) deployments.push(deployment);
        else counts.unlinked += 1;
        break;
      }
      default:
        break;
    }
  }

  const allLaunches = buildLaunches(events, tombstones);
  // A draft is a founder's unfinished record — it is not a live launch, and
  // listing one here would answer "what is happening" with a maybe.
  const launches = allLaunches.filter(
    (launch) => effectiveStage(launch) !== "draft",
  );
  const launchName = new Map<string, string>();
  for (const launch of allLaunches) {
    launchName.set(
      `${launch.record.author}:${launch.record.id}`,
      launch.record.name,
    );
  }

  const projects = deriveBoard({
    pitches,
    nodes,
    requests,
    grants,
    me: input.me ?? null,
  });
  const byProjectId = new Map<string, ProjectSummary>();
  for (const summary of projects) {
    const current = byProjectId.get(summary.projectId);
    if (!current || summary.updatedAt > current.updatedAt) {
      byProjectId.set(summary.projectId, summary);
    }
  }

  // --- DAOs: summon receipts first, deployments merged over them. -------
  const cards = new Map<string, DaoCard>();
  const summonReceipts = [...receipts]
    .filter((receipt) => receipt.table === "summon")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const receipt of summonReceipts) {
    if (!launchName.has(receipt.launchKey)) counts.orphanReceipts += 1;
    const payload = summonPayload(receipt);
    if (!payload.dao) {
      // A summon row without a proven address cannot become a DAO card —
      // counted so the line above the grid still tells the reader about it.
      counts.malformed += 1;
      continue;
    }
    // Newest receipt per project wins (already sorted newest-first), so a
    // re-summon replaces the card rather than doubling it.
    const projectId = payload.project ?? receipt.launchId;
    const launch = launchName.get(receipt.launchKey);
    const summary = byProjectId.get(projectId);
    cards.set(projectId, {
      projectId,
      name: summary?.name ?? launch ?? projectId,
      dao: payload.dao,
      contract: null,
      chainId: toChainNumber(payload.chainId),
      addressUrl: null,
      txUrl: null,
      summonTx: receipt.tx,
      deploymentTx: null,
      teamSize: null,
      teamSource: null,
      mintedSeats: payload.holders,
      founder: summary?.founder ?? null,
      hasPitch: Boolean(summary),
      openRoles: summary?.openRoles ?? [],
      updatedAt: receipt.createdAt,
      sources: ["kind:47005 summon receipt"],
    });
  }
  for (const deployment of deployments) {
    const projectId = deployment.project;
    if (!projectId) continue;
    const summary = byProjectId.get(projectId);
    let card = cards.get(projectId);
    if (!card) {
      card = {
        projectId,
        name: summary?.name ?? projectId,
        // A deployment documents a contract, never a treasury: `dao` stays
        // null here unless a summon receipt already proved one above.
        dao: null,
        contract: null,
        chainId: null,
        addressUrl: null,
        txUrl: null,
        summonTx: null,
        deploymentTx: null,
        teamSize: null,
        teamSource: null,
        mintedSeats: null,
        founder: summary?.founder ?? null,
        hasPitch: Boolean(summary),
        openRoles: summary?.openRoles ?? [],
        updatedAt: deployment.createdAt,
        sources: [],
      };
      cards.set(projectId, card);
    }
    if (!card.contract) {
      card.contract = { role: deployment.role, address: deployment.address };
    }
    card.deploymentTx ??= deployment.tx;
    card.chainId ??= toChainNumber(deployment.chainId);
    card.updatedAt = Math.max(card.updatedAt, deployment.createdAt);
    card.sources.push(`kind:37018 ${deployment.role} deployment`);
  }
  for (const card of cards.values()) {
    const summary = byProjectId.get(card.projectId);
    if (summary) {
      // Team size comes from the equity map (the same derivation the board
      // prints), so Discover and the Project Board cannot disagree.
      card.name = summary.name;
      card.founder = summary.founder;
      card.hasPitch = true;
      card.openRoles = summary.openRoles;
      card.updatedAt = Math.max(card.updatedAt, summary.updatedAt);
      card.teamSize = summary.members;
      card.teamSource = "equity-map";
    } else if (card.mintedSeats !== null) {
      card.teamSize = card.mintedSeats;
      card.teamSource = "summon-receipt";
    }
    const shown = card.dao ?? card.contract?.address ?? null;
    card.addressUrl =
      shown && card.chainId !== null
        ? explorerAddressUrl(card.chainId, shown)
        : null;
    const tx = card.summonTx ?? card.deploymentTx;
    card.txUrl =
      tx && card.chainId !== null ? explorerTxUrl(card.chainId, tx) : null;
  }
  const daos = [...cards.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  return { daos, launches, projects, counts };
}

/**
 * Whether a launch can still be backed — the only stages whose auction is
 * open (`models.ts` `LaunchStage`). A graduated raise now lives in the DAOs
 * section and a failed one is over: both are still *listed* (hiding them
 * would make the directory lie by omission) but their card must not offer a
 * "Back this launch" that cannot be completed.
 */
export function canBackLaunch(stage: LaunchStage): boolean {
  return stage === "live" || stage === "funding";
}

/**
 * The target line for a launch card — the record's own graduation threshold,
 * through the launchpad's own money formatter (`amounts.ts formatMoney`, the
 * same call `LaunchDetailPage` uses for "Graduation threshold"), so a raw
 * atomic figure is never printed as if it were tokens. An absent figure
 * stays absent.
 */
export function launchTargetText(launch: Launch): string | null {
  const goal = launch.record.requiredRaised;
  if (!goal) return null;
  return formatMoney(goal);
}

/** The line above the grids: what could not be listed, in the reader's words. */
export function directoryNotice(counts: DirectoryCounts): string | null {
  const parts: string[] = [];
  if (counts.malformed > 0) {
    parts.push(
      `${counts.malformed} record${counts.malformed === 1 ? "" : "s"} could not be read — counted, not listed`,
    );
  }
  if (counts.unlinked > 0) {
    parts.push(
      `${counts.unlinked} deployment${counts.unlinked === 1 ? "" : "s"} name no project`,
    );
  }
  if (counts.orphanReceipts > 0) {
    parts.push(
      `${counts.orphanReceipts} summon receipt${counts.orphanReceipts === 1 ? "" : "s"} with no launch record on this relay`,
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join(" · ")}.`;
}
