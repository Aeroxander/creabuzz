import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import { useAccount } from "./account";

/**
 * Run `action` when the person has an account; otherwise take them to sign up, and back here once they have one.
 * Returns whether the action ran.
 */
export function useRequireAccount() {
  const { pubkey } = useAccount();
  const navigate = useNavigate();
  const here = useRouterState({
    select: (s) => s.location.pathname + (s.location.searchStr ?? ""),
  });
  return useCallback(
    (action: () => void): boolean => {
      if (pubkey) {
        action();
        return true;
      }
      void navigate({ to: "/welcome", search: { next: here } });
      return false;
    },
    [pubkey, navigate, here],
  );
}
