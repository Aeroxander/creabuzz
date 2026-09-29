/**
 * Durable deploy progress for the auction deploy flow, keyed by launch id.
 *
 * The deploy is a seven-transaction sequence whose CREATE addresses are
 * predicted from the wallet's nonce. A reload used to lose every prediction
 * and receipt, so the re-run re-derived fresh addresses and silently deployed
 * (and linked) a second auction. This store persists the flow's step state —
 * predicted addresses, tx hashes, completion — to localStorage as the flow
 * advances, BEFORE the step's own effects run, so a crash between a predicted
 * address and its transaction resumes from the prediction and the on-chain
 * `codeAt` idempotency guards in `runAuctionDeploy` engage instead of a
 * duplicate CREATE.
 *
 * Persistence is an idempotency AID, not the authority: the on-chain code
 * checks remain the final word, so a missing, full, or corrupt store degrades
 * to re-derivation (today's behavior) rather than blocking a deploy. Progress
 * is stamped with a fingerprint of the sale plan — a relaunch changes the
 * plan, so stale progress from a dead deployment can never fence the new one.
 */
import {
  initAuctionDeployState,
  type AuctionDeployState,
  type AuctionDeployStepId,
  type AuctionDeployStepState,
  type AuctionPlanInputs,
} from "./auctionFlow.ts";

/** The `localStorage` subset this store needs (injectable for tests). */
export interface DeployProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DeployProgressSnapshot {
  version: 1;
  /**
   * Fingerprint of the sale plan this progress belongs to; progress saved for
   * a different plan (an edit or a relaunch) is ignored, not merged.
   */
  fingerprint: string;
  steps: Record<AuctionDeployStepId, AuctionDeployStepState>;
  /** The CREATE2 auction address, once predicted. */
  auctionAddress: string | null;
}

/** Stable identity of the sale terms the predicted addresses belong to. */
export function deployProgressFingerprint(plan: AuctionPlanInputs): string {
  return [
    plan.token,
    plan.tokenSupply,
    plan.currency,
    plan.floorPrice,
    plan.tickSpacing,
    plan.requiredRaised,
    plan.startBlock ?? "",
    plan.endBlock ?? "",
    plan.claimBlock ?? "",
    plan.treasury,
    plan.admission,
  ].join(" ");
}

export function progressStorageKey(launchId: string): string {
  return `buzz:launchpad:deploy-progress:${launchId}`;
}

function browserStorage(): DeployProgressStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage denied outright (privacy modes): progress lives in this session
    // only; the on-chain guards stay authoritative. Nothing to retry.
    return null;
  }
}

/**
 * Persist the flow's step state. Called from the dispatch seam BEFORE the
 * step's effects run, so the predicted address is durable before its
 * transaction can broadcast. A failed write is retried on every later
 * dispatch (each one rewrites the whole snapshot).
 */
export function saveDeployProgress(
  launchId: string,
  fingerprint: string,
  state: AuctionDeployState,
  storage: DeployProgressStorage | null = browserStorage(),
): void {
  if (!storage) return;
  const snapshot: DeployProgressSnapshot = {
    version: 1,
    fingerprint,
    steps: state.steps,
    auctionAddress: state.auctionAddress,
  };
  try {
    storage.setItem(progressStorageKey(launchId), JSON.stringify(snapshot));
  } catch {
    // Quota/denied: the next dispatch retries; on-chain code checks still
    // prevent duplicate deploys even if this never lands.
  }
}

/**
 * Load this launch's progress for the given plan fingerprint. A missing,
 * corrupt, or differently-fingerprinted store reads as "no progress".
 */
export function loadDeployProgress(
  launchId: string,
  fingerprint: string,
  storage: DeployProgressStorage | null = browserStorage(),
): DeployProgressSnapshot | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(progressStorageKey(launchId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DeployProgressSnapshot> | null;
    if (parsed === null) return null;
    if (
      parsed.version !== 1 ||
      parsed.fingerprint !== fingerprint ||
      !parsed.steps ||
      typeof parsed.steps !== "object"
    ) {
      return null;
    }
    return {
      version: 1,
      fingerprint,
      steps: parsed.steps,
      auctionAddress:
        typeof parsed.auctionAddress === "string"
          ? parsed.auctionAddress
          : null,
    };
  } catch {
    // Corrupt store: ignore it (chain guards stay authoritative).
    return null;
  }
}

/**
 * Seed a fresh flow state from persisted progress — the reload seam the
 * `useReducer` initializer calls. A step interrupted mid-flight ("running")
 * becomes retryable ("failed") while keeping its predicted address and tx
 * hash, so the idempotency guards and the retry affordance both engage.
 */
export function seedAuctionDeployState(
  admission: "curated" | "community",
  snapshot: DeployProgressSnapshot | null,
): AuctionDeployState {
  const base = initAuctionDeployState(admission);
  if (!snapshot) return base;
  const steps = { ...base.steps };
  for (const id of Object.keys(steps) as AuctionDeployStepId[]) {
    const saved = snapshot.steps[id];
    if (!saved || typeof saved !== "object") continue;
    steps[id] = {
      status: saved.status === "running" ? "failed" : saved.status,
      txHash: typeof saved.txHash === "string" ? saved.txHash : null,
      address: typeof saved.address === "string" ? saved.address : null,
      alreadyDeployed: Boolean(saved.alreadyDeployed),
    };
  }
  return { ...base, steps, auctionAddress: snapshot.auctionAddress };
}

/**
 * Monotonic in-flight fence for async reads (the readiness `check()`): each
 * run takes a token and only the newest may settle, so a slow earlier answer
 * can never overwrite a newer one.
 */
export interface GenerationFence {
  /** Take the next (now newest) generation token. */
  next(): number;
  /** True while `token` is still the newest generation. */
  isCurrent(token: number): boolean;
}

export function makeGenerationFence(): GenerationFence {
  let generation = 0;
  return {
    next: () => ++generation,
    isCurrent: (token: number) => token === generation,
  };
}

/** Settle an async result only if its `token` is still the newest generation. */
export function settleIfCurrent(
  fence: GenerationFence,
  token: number,
  settle: () => void,
): void {
  if (fence.isCurrent(token)) settle();
}
