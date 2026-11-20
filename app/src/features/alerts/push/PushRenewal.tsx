/**
 * Saves this device at the server again once it has been 30 days (the server forgets a device after 90), whenever the app is
 * opened. Draws nothing. Only for a device the signed-in account saved, and only where the server says it sends alerts.
 */
import { serverWebPushKey } from "@creaton/core/client/server-settings.ts";
import { useEffect } from "react";
import { useAccount } from "../../../lib/account";
import { investingOn } from "../../../lib/server";
import { deviceCanShowAlerts, renewIfDue } from "./push-device";

export default function PushRenewal() {
  const { pubkey } = useAccount();
  useEffect(() => {
    if (!pubkey || !investingOn() || !serverWebPushKey()) return;
    if (!deviceCanShowAlerts()) return;
    void renewIfDue(pubkey);
  }, [pubkey]);
  return null;
}
