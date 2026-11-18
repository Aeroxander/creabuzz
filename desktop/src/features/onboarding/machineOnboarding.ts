import * as React from "react";
import { type QueryStatus, useQueryClient } from "@tanstack/react-query";

import { useIdentityQuery } from "@/shared/api/hooks";

const MACHINE_ONBOARDING_COMPLETION_STORAGE_KEY =
  "buzz-machine-onboarding-complete.v2";
const LEGACY_ONBOARDING_COMPLETION_STORAGE_KEY = "buzz-onboarding-complete.v1";

type MachineOnboardingStage =
  | "blocking"
  | "keyring-locked"
  | "onboarding"
  | "ready"
  | "relaunch-required"
  | "reset-failed";

function completionKey(prefix: string, pubkey: string) {
  return `${prefix}:${pubkey}`;
}

export function readMachineOnboardingCompletion(pubkey: string | null) {
  if (typeof window === "undefined" || !pubkey) return false;
  return (
    window.localStorage.getItem(
      completionKey(MACHINE_ONBOARDING_COMPLETION_STORAGE_KEY, pubkey),
    ) === "true"
  );
}

function clearMachineOnboardingCompletion(pubkey: string | null) {
  if (typeof window === "undefined" || !pubkey) return;
  window.localStorage.removeItem(
    completionKey(MACHINE_ONBOARDING_COMPLETION_STORAGE_KEY, pubkey),
  );
}

function forceMachineOnboarding() {
  if (!import.meta.env?.DEV || typeof window === "undefined") return false;
  return (
    new URL(window.location.href).searchParams.get("machineOnboarding") === "1"
  );
}

/** @internal Exported for unit testing only. */
export function migrateMachineOnboardingCompletion(
  pubkey: string,
  /**
   * The `pubkey` field of the active community from localStorage, or
   * `undefined` if no community is configured. Community-creation paths stamp
   * the current identity's pubkey on write; absent pubkey (`null`) therefore
   * indicates a legacy entry that pre-dates the stamp and is NOT treated as a
   * voucher. Pass `undefined` when there is no active community at all.
   *
   * Using the community's own pubkey prevents a freshly generated post-reset
   * key from being vouched for by a stale community entry that survived the
   * webview wipe.
   */
  activeCommunityPubkey: string | null | undefined,
  isSharedIdentity: boolean,
) {
  if (forceMachineOnboarding()) return false;
  if (readMachineOnboardingCompletion(pubkey)) return true;

  const completedLegacyOnboarding =
    window.localStorage.getItem(
      completionKey(LEGACY_ONBOARDING_COMPLETION_STORAGE_KEY, pubkey),
    ) === "true";

  // A community entry vouches for the current pubkey only when its recorded
  // pubkey matches. Absent pubkey (legacy entries predating the stamp) and
  // no community at all (undefined) do not vouch — after community creation
  // paths stamp pubkey on write, absent means the entry pre-dates the stamp
  // and cannot be trusted to identify which identity created it.
  const communityVouchesForPubkey =
    activeCommunityPubkey !== undefined &&
    activeCommunityPubkey !== null &&
    activeCommunityPubkey === pubkey;

  if (
    !completedLegacyOnboarding &&
    !communityVouchesForPubkey &&
    !isSharedIdentity
  ) {
    return false;
  }

  window.localStorage.setItem(
    completionKey(MACHINE_ONBOARDING_COMPLETION_STORAGE_KEY, pubkey),
    "true",
  );
  return true;
}

function identitySettled(status: QueryStatus, isFetching: boolean) {
  return !isFetching && (status === "success" || status === "error");
}

/**
 * The cold-boot stage decision, as a pure function so it can be pinned by
 * tests (the hook itself needs React).
 *
 * FIRST RUN: a settled identity query with no pubkey is a KNOWN-ABSENT
 * identity, not an unknown one. It must reach `onboarding` — blocking on a
 * missing pubkey stranded every fresh install on the loading gate forever,
 * because `!currentPubkey` was checked before the onboarding branch and there
 * is no identity yet for it to wait on.
 */
export function resolveMachineStage(p: {
  identityStatus: string;
  identityIsFetching: boolean;
  currentPubkey: string | null;
  identityLost: boolean;
  identityLocked: boolean;
  identityResetFailed: boolean;
  relaunchRequired: boolean;
  hasCompletedCurrentPubkey: boolean;
  evaluatedPubkey: string | null;
  continuingPubkey: string | null;
}): MachineOnboardingStage {
  const settled = identitySettled(
    p.identityStatus as QueryStatus,
    p.identityIsFetching,
  );
  const knownAbsent =
    p.identityStatus === "success" && !p.identityLost && !p.currentPubkey;

  if (p.identityResetFailed && p.identityStatus === "success") {
    return "reset-failed";
  }
  if (p.identityLocked && p.identityStatus === "success") {
    return "keyring-locked";
  }
  if (p.relaunchRequired) {
    return "relaunch-required";
  }
  if (p.identityLost && p.identityStatus === "success") {
    return "onboarding";
  }
  if (p.identityStatus === "error") {
    return "ready";
  }
  if (
    !settled ||
    // A settled query that resolved no identity is first run, not "unknown" —
    // it must fall through to onboarding, never hold the loading gate.
    (!p.currentPubkey && !knownAbsent) ||
    // Imported identities are published before the flow can advance to setup.
    // Keep that explicitly requested identity switch in onboarding; only the
    // startup identity needs the one-render evaluation gate.
    (!p.hasCompletedCurrentPubkey &&
      p.evaluatedPubkey !== p.currentPubkey &&
      p.continuingPubkey !== p.currentPubkey)
  ) {
    return "blocking";
  }
  if (
    p.identityLost ||
    knownAbsent ||
    p.continuingPubkey === p.currentPubkey ||
    !p.hasCompletedCurrentPubkey
  ) {
    return "onboarding";
  }
  return "ready";
}

export function useMachineOnboardingState({
  activeCommunityPubkey,
  isSharedIdentity,
}: {
  activeCommunityPubkey: string | null | undefined;
  isSharedIdentity: boolean;
}) {
  const queryClient = useQueryClient();
  const identityQuery = useIdentityQuery();
  const identity = identityQuery.data;
  const currentPubkey = identity?.pubkey ?? null;
  const identityLost = identity?.lost === true;
  const identityLocked = identity?.locked === true;
  const identityResetFailed = identity?.resetFailed === true;
  const [completedPubkey, setCompletedPubkey] = React.useState<string | null>(
    () =>
      currentPubkey &&
      !forceMachineOnboarding() &&
      readMachineOnboardingCompletion(currentPubkey)
        ? currentPubkey
        : null,
  );
  const [evaluatedPubkey, setEvaluatedPubkey] = React.useState<string | null>(
    null,
  );
  const continuingPubkeyRef = React.useRef<string | null>(null);
  const startupPubkeyRef = React.useRef<string | null>(null);
  const [bootedLost, setBootedLost] = React.useState(false);
  const [bootedLocked, setBootedLocked] = React.useState(false);

  React.useEffect(() => {
    if (
      identityQuery.status === "success" &&
      startupPubkeyRef.current === null
    ) {
      startupPubkeyRef.current = currentPubkey;
    }
  }, [currentPubkey, identityQuery.status]);
  React.useEffect(() => {
    if (identityLost) setBootedLost(true);
  }, [identityLost]);
  React.useEffect(() => {
    if (identityLocked) setBootedLocked(true);
  }, [identityLocked]);

  React.useEffect(() => {
    if (
      !currentPubkey ||
      currentPubkey !== startupPubkeyRef.current ||
      identityQuery.status !== "success" ||
      identityLost
    ) {
      return;
    }
    if (
      migrateMachineOnboardingCompletion(
        currentPubkey,
        activeCommunityPubkey,
        isSharedIdentity,
      )
    ) {
      setCompletedPubkey(currentPubkey);
    }
    setEvaluatedPubkey(currentPubkey);
  }, [
    currentPubkey,
    activeCommunityPubkey,
    identityLost,
    identityQuery.status,
    isSharedIdentity,
  ]);

  const complete = React.useCallback(
    (completedIdentityPubkey?: string) => {
      const pubkey = completedIdentityPubkey ?? currentPubkey;
      if (!pubkey) return;
      window.localStorage.setItem(
        completionKey(MACHINE_ONBOARDING_COMPLETION_STORAGE_KEY, pubkey),
        "true",
      );
      // Clear the "continuing" marker so completion actually settles the flow.
      // Imported/recovered identities set continuingPubkeyRef to pin the stage
      // to "onboarding" until setup finishes; leaving it set after complete()
      // keeps the stage pinned forever, so Skip/Next appear to do nothing.
      continuingPubkeyRef.current = null;
      setCompletedPubkey(pubkey);
    },
    [currentPubkey],
  );

  const continueWithIdentity = React.useCallback((pubkey: string) => {
    continuingPubkeyRef.current = pubkey;
  }, []);

  const continueWithRecoveredIdentity = React.useCallback((pubkey: string) => {
    continuingPubkeyRef.current = pubkey;
    setBootedLost(false);
    setBootedLocked(false);
  }, []);

  const reopen = React.useCallback(() => {
    clearMachineOnboardingCompletion(currentPubkey);
    setCompletedPubkey((pubkey) => (pubkey === currentPubkey ? null : pubkey));
    setEvaluatedPubkey(currentPubkey);
  }, [currentPubkey]);

  const relaunchRequired =
    ((bootedLost && !identityLost) || (bootedLocked && !identityLocked)) &&
    identityQuery.status === "success";
  const hasCompletedCurrentPubkey =
    completedPubkey === currentPubkey ||
    (!forceMachineOnboarding() &&
      readMachineOnboardingCompletion(currentPubkey));

  const stage = resolveMachineStage({
    identityStatus: identityQuery.status,
    identityIsFetching: identityQuery.fetchStatus === "fetching",
    currentPubkey,
    identityLost,
    identityLocked,
    identityResetFailed,
    relaunchRequired,
    hasCompletedCurrentPubkey,
    evaluatedPubkey,
    continuingPubkey: continuingPubkeyRef.current,
  });

  return {
    complete,
    continueWithIdentity,
    continueWithRecoveredIdentity,
    currentPubkey,
    identityLost,
    queryClient,
    reopen,
    stage,
  };
}
