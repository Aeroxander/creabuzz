/**
 * Where "What did you get done?" lives on a project page. One provider holds the solo flow (`useSoloWin`) and the
 * dialog's open state, so the first-week card, a task row and a promise line (through `openSoloWin`) all open the same
 * box and share what a try that stopped got to.
 *
 * It offers nothing to an agent-labelled account or to a founder with another person on the project: `available` is
 * false there, no box is mounted, and the full task form is the way. Outside a provider, `available` is false.
 */

import { toast } from "sonner";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { onOpenSoloWin } from "../lib/solo-win-events";
import type { SoloPending } from "../lib/solo-win";
import type { Launch } from "../models";
import { useSoloWin } from "../use-tasks";
import { SoloWinDialog, type SoloWinOpen } from "./SoloWinDialog";

interface SoloAccess {
  available: boolean;
  /** Open the box: to say what was done, to finish a task that exists, or to add something to do. */
  open: (what: SoloWinOpen) => void;
  /** A try that stopped part of the way, kept in this tab: where it stopped and what it was for. */
  pending: SoloPending | null;
}

const NONE: SoloAccess = {
  available: false,
  open: () => undefined,
  pending: null,
};

const Access = createContext<SoloAccess>(NONE);

/** What the solo box offers this viewer on this page. */
export function useSoloAccess(): SoloAccess {
  return useContext(Access);
}

export function SoloWinProvider({
  launch,
  children,
}: {
  launch: Launch;
  children: ReactNode;
}) {
  const solo = useSoloWin(launch.record);
  const [opened, setOpened] = useState<SoloWinOpen | null>(null);
  const { available, pending } = solo;
  const open = useCallback(
    (what: SoloWinOpen) => {
      if (available) setOpened(what);
    },
    [available],
  );
  useEffect(
    () =>
      available
        ? onOpenSoloWin(({ text, taskId }) =>
            setOpened({
              mode: taskId ? "finish" : "full",
              ...(text ? { text } : {}),
              ...(taskId ? { taskId } : {}),
            }),
          )
        : undefined,
    [available],
  );
  const access = useMemo(
    () => ({ available, open, pending }),
    [available, open, pending],
  );
  return (
    <Access.Provider value={access}>
      {children}
      {available && opened ? (
        <SoloWinDialog
          launch={launch}
          onClose={() => setOpened(null)}
          onSaid={(words) => toast.success(words)}
          open={opened}
          solo={solo}
        />
      ) : null}
    </Access.Provider>
  );
}
