/**
 * What stands between a founder and pressing Start on a contributor project, checked before anything is sent, and the
 * id a new project takes.
 *
 * Two of the checks exist because the failure they prevent comes too late otherwise: a passkey identity that is locked
 * this session can make the DAO (the passkey account signs that) and then cannot publish the record (D144), and a list of
 * the founder's projects that could not be read gives a new project the id, and so the DAO address, of an old one.
 *
 * Alias-free: `contributor-gate.test.mjs` drives it under `node --test`.
 */

import { ideaId } from "../../launchpad/lib/idea.ts";

type ContributorGateReason =
  | "reading"
  | "no-network"
  | "mainnet"
  | "unavailable"
  | "no-currency"
  | "sign-in"
  | "locked"
  | "projects-reading"
  | "projects-unreadable"
  | "wallet"
  | "wrong-chain";

/** What stands between the founder and pressing Start, in words they can act on. */
export type ContributorGate =
  | { ok: true }
  | { ok: false; reason: ContributorGateReason; message: string };

export interface ContributorGateInput {
  network: {
    pending: boolean;
    failed: boolean;
    data: {
      chainId: number;
      kit: string | null;
      currency: string | null;
      decimals: number | null;
      /** Why the kit this network names cannot be used from this build (`lib/weekly-sale.ts`); null or absent when it can. */
      kitProblem?: string | null;
    } | null;
  };
  /** True when the network is a main network and this build does not offer one. */
  mainnetRefused: boolean;
  /** The founder's public key; null when signed out. */
  me: string | null;
  /** The signer's refusal when this browser cannot sign right now (a locked passkey), else null. */
  signingBlocked: string | null;
  /** The founder's projects, and the ones they took off the list: both are needed to give a new one an id of its own. */
  projects: "reading" | "failed" | "read";
  wallet: {
    kind: "wallet" | "passkey" | null;
    address: string | null;
    accountsChecked: boolean;
    chainId: number | null;
    passkeyOffered: boolean;
    /** Where a passkey account's fees are covered, as words ("the test network", or a real network's name); null when not known. */
    passkeyFeesOn?: string | null;
  };
  /** A network's name for people. */
  label: (chainId: number) => string;
}

export const LOCKED_GATE_MESSAGE =
  "Unlock your passkey first: the project is published under your name, and this browser needs your passkey to confirm it.";

export function contributorGate(input: ContributorGateInput): ContributorGate {
  const { network, wallet, label } = input;
  if (network.pending)
    return { ok: false, reason: "reading", message: "Reading the network…" };
  if (network.failed || !network.data)
    return {
      ok: false,
      reason: "no-network",
      message:
        "The network could not be reached. Check the network setting and try again.",
    };
  const { chainId, kit, currency, decimals, kitProblem } = network.data;
  if (input.mainnetRefused)
    return {
      ok: false,
      reason: "mainnet",
      message:
        "Contributor projects are only offered on test networks for now.",
    };
  if (!kit)
    return {
      ok: false,
      reason: "unavailable",
      message: `Contributor projects cannot be started on ${label(chainId)} yet: this app cannot make them there.`,
    };
  if (kitProblem)
    return { ok: false, reason: "unavailable", message: kitProblem };
  if (!currency || decimals === null)
    return {
      ok: false,
      reason: "no-currency",
      message: `This app does not know a currency on ${label(chainId)} for contributors' optional deposits, so it cannot open a work budget there.`,
    };
  if (!input.me)
    return {
      ok: false,
      reason: "sign-in",
      message: "Sign in first: the project is published under your name.",
    };
  if (input.signingBlocked)
    return { ok: false, reason: "locked", message: LOCKED_GATE_MESSAGE };
  if (input.projects === "reading")
    return {
      ok: false,
      reason: "projects-reading",
      message: "Reading your projects…",
    };
  if (input.projects === "failed")
    return {
      ok: false,
      reason: "projects-unreadable",
      message:
        "Your projects could not be read, so a new one cannot be given a name of its own yet. Try again.",
    };
  if (!wallet.address)
    return {
      ok: false,
      reason: "wallet",
      message:
        wallet.kind === "passkey"
          ? wallet.accountsChecked
            ? "Your passkey account could not be read. Reload the page to try again."
            : "Reading your passkey account…"
          : wallet.kind === null && wallet.passkeyOffered
            ? `Set up passkey sign-in from your profile menu: your passkey account holds your starting Shares and makes the project${wallet.passkeyFeesOn ? `, with its fees covered on ${wallet.passkeyFeesOn}` : ""}. Or connect a wallet app.`
            : "Connect a wallet app. It holds your starting Shares and confirms the one step that makes the project.",
    };
  if (wallet.chainId !== chainId)
    return {
      ok: false,
      reason: "wrong-chain",
      message:
        wallet.kind === "passkey"
          ? `Your passkey account works on ${label(wallet.chainId ?? 0)}, but this site's projects are on ${label(chainId)}.`
          : `Your wallet app is on another network. Switch it to ${label(chainId)}.`,
    };
  return { ok: true };
}

/**
 * Whether a project set up earlier (kept in this browser) can be carried on now: by the account that started it, and
 * not while the passkey identity is locked. Its record is still to be published under the founder's name, so a locked
 * identity would make the DAO (or send the next step) and then stop at the record, the same trap the fresh start's gate
 * keeps people out of (D144). `signingBlocked` is read when the person presses, not when the page drew.
 */
export function canResume(input: {
  job: { founder: string };
  wallet: string | null;
  signingBlocked: string | null;
}): boolean {
  return (
    input.signingBlocked === null &&
    input.wallet !== null &&
    input.wallet.toLowerCase() === input.job.founder.toLowerCase()
  );
}

/**
 * The id a new project takes: the Projects-board project's own id when it starts from one and that id was never used,
 * else the name's slug, with a suffix when the founder has, or ever had, a project by that id. A removed project's id
 * is never reused: the DAO's address follows from the id, so reusing it would pick up the removed project's DAO, its
 * reviewers and work areas, and publish the new words over it.
 *
 * One id is kept on purpose: `fromIdea`, the founder's own project that has no Shares yet (the caller checks that it
 * is one). Setting up Shares for it carries on the same project, so its page, goal, updates, record and followers stay
 * with it. Such a project never had a DAO, so there is none to pick up.
 */
export function freshLaunchId(
  input: {
    name: string;
    fromBoard?: string;
    /** The founder's own project without Shares that this one carries on, by id. */
    fromIdea?: string;
    /** The founder's projects on the list. */
    mine: readonly string[];
    /** The founder's projects ever taken off it. */
    removed: readonly string[];
  },
  random?: () => number,
): string {
  if (
    input.fromIdea &&
    input.mine.includes(input.fromIdea) &&
    !input.removed.includes(input.fromIdea)
  )
    return input.fromIdea;
  const taken = [...input.mine, ...input.removed];
  if (input.fromBoard && !taken.includes(input.fromBoard))
    return input.fromBoard;
  return ideaId(input.name, taken, random);
}
