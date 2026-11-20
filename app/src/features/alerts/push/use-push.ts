/**
 * The card's state for alerts away from the app: what this device says, and the two presses. The state is read when the card
 * opens (never asking the browser for anything), and a press moves it only to what actually happened.
 */
import { serverWebPushKey } from "@creaton/core/client/server-settings.ts";
import { useCallback, useEffect, useState } from "react";
import {
  deviceCanShowAlerts,
  readDeviceState,
  retryRemovals,
  turnOff,
  turnOn,
} from "./push-device";

export type PushView =
  | "checking"
  | "cannot"
  | "blocked"
  | "off"
  | "on"
  | "working";

/** What the last press ended in, said once under the card's sentence. */
export type PushNote =
  | "off-done"
  | "off-pending"
  | "off-failed"
  | "failed"
  | null;

export function usePushAlerts(me: string) {
  const key = serverWebPushKey();
  const [view, setView] = useState<PushView>("checking");
  const [note, setNote] = useState<PushNote>(null);

  useEffect(() => {
    if (!deviceCanShowAlerts()) {
      setView("cannot");
      return;
    }
    let live = true;
    void readDeviceState(me).then((state) => live && setView(state));
    // A removal the server did not confirm last time is asked again whenever the card is opened.
    void retryRemovals(me);
    return () => {
      live = false;
    };
  }, [me]);

  const on = useCallback(async () => {
    if (!key) return;
    setNote(null);
    setView("working");
    const result = await turnOn(me, key);
    if (result === "on") setView("on");
    else if (result === "blocked") setView("blocked");
    else {
      // Closing the browser's question is not an error: the card is as it was.
      setView("off");
      if (result === "failed") setNote("failed");
    }
  }, [me, key]);

  const off = useCallback(async () => {
    setNote(null);
    setView("working");
    const result = await turnOff(me);
    if (result === "failed") {
      setView("on");
      setNote("off-failed");
      return;
    }
    setView("off");
    setNote(result === "off" ? "off-done" : "off-pending");
  }, [me]);

  return { view, note, on, off };
}
