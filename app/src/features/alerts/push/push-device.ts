/**
 * Alerts on this device (plan sections 6.3 and 7.8): reading where they stand, turning them on and off, and saving the device
 * again before the server forgets it. Only the person's press asks the browser for permission; nothing here asks on its own.
 *
 * A device's subscription is only ever used for the account that saved it. A subscription left by another account (or by
 * a store that was cleared) is dropped and made again, so alerts for one person never reach a device another person is now
 * using. Every failure is said, never turned into "on": a device that the server did not accept is unsubscribed again.
 */
import { forgetDevice, saveDevice } from "./push-calls";
import {
  addPending,
  clearPending,
  readPending,
  readSaved,
  writeSaved,
} from "./push-store";

/** How long the browser may take to have the app's worker ready before turning alerts on is said to have failed. */
const READY_WAIT_MS = 8_000;
/** The server keeps a device for 90 days; the app saves it again once it is older than this. */
const RENEW_AFTER_SECS = 30 * 86_400;

const nowSecs = () => Math.floor(Date.now() / 1000);

/** Whether this browser can show alerts at all: a worker, the push manager and notifications. */
export function deviceCanShowAlerts(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** What the person has told the browser, without asking. */
function permissionNow(): NotificationPermission {
  return typeof Notification === "undefined"
    ? "default"
    : Notification.permission;
}

/** The server's key as the bytes the push manager wants. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const text = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(88, "="));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

async function registrationNow(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

async function registrationReady(): Promise<ServiceWorkerRegistration | null> {
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(resolve, READY_WAIT_MS, null)),
    ]);
  } catch {
    return null;
  }
}

/** Whether a subscription was made with the server's key. */
function madeWith(sub: PushSubscription, key: string): boolean {
  const have = sub.options?.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  const b = keyBytes(key);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export type DeviceState = "off" | "on" | "blocked";

/** Where alerts stand for `me` on this device: on only when this device was saved at the server by this account. */
export async function readDeviceState(me: string): Promise<DeviceState> {
  if (permissionNow() === "denied") return "blocked";
  if (permissionNow() !== "granted") return "off";
  const registration = await registrationNow();
  const sub = registration
    ? await registration.pushManager.getSubscription().catch(() => null)
    : null;
  const saved = readSaved();
  return sub && saved && saved.account === me && saved.endpoint === sub.endpoint
    ? "on"
    : "off";
}

/** How turning alerts on ended. */
export type TurnOnResult = "on" | "blocked" | "dismissed" | "failed";

/**
 * Turn alerts on: ask the browser (this is the only place that does), subscribe with the server's key, and save the device at
 * the server. A subscription the server did not accept is taken back, so nothing is left half on.
 */
export async function turnOn(me: string, key: string): Promise<TurnOnResult> {
  if (!deviceCanShowAlerts()) return "failed";
  let asked: NotificationPermission;
  try {
    asked = await Notification.requestPermission();
  } catch {
    return "failed";
  }
  if (asked === "denied") return "blocked";
  if (asked !== "granted") return "dismissed";
  const registration = await registrationReady();
  if (!registration) return "failed";
  let made: PushSubscription | null = null;
  try {
    let sub = await registration.pushManager.getSubscription();
    const saved = readSaved();
    // Only a subscription this account saved, made with this server's key, is used again.
    if (
      sub &&
      !(
        saved &&
        saved.account === me &&
        saved.endpoint === sub.endpoint &&
        madeWith(sub, key)
      )
    ) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      });
      made = sub;
    }
    await saveDevice(sub.toJSON());
    writeSaved({ account: me, endpoint: sub.endpoint, savedAt: nowSecs() });
    return "on";
  } catch {
    // Nothing is left half on: a subscription this press made is taken back, and nothing is remembered as saved.
    await made?.unsubscribe().catch(() => undefined);
    return "failed";
  }
}

/** How turning alerts off ended. */
export type TurnOffResult = "off" | "off-pending" | "failed";

/**
 * Turn alerts off: the browser stops first (so nothing more can reach this device), then the server is asked to delete what
 * it kept. A server that cannot be reached is remembered and asked again (`retryRemovals`), and the person is told so.
 */
export async function turnOff(me: string): Promise<TurnOffResult> {
  const registration = await registrationNow();
  const sub = registration
    ? await registration.pushManager.getSubscription().catch(() => null)
    : null;
  const endpoint = sub?.endpoint ?? readSaved()?.endpoint ?? null;
  if (sub) {
    try {
      if (!(await sub.unsubscribe())) return "failed";
    } catch {
      return "failed";
    }
  }
  writeSaved(null);
  if (!endpoint) return "off";
  try {
    await forgetDevice(endpoint);
    return "off";
  } catch {
    addPending(me, endpoint, nowSecs());
    return "off-pending";
  }
}

/** Ask the server again to forget devices of `me` it has not yet confirmed forgetting. */
export async function retryRemovals(me: string): Promise<void> {
  for (const pending of readPending(nowSecs())) {
    if (pending.account !== me) continue;
    try {
      await forgetDevice(pending.endpoint);
      clearPending(me, pending.endpoint, nowSecs());
    } catch {
      // Still not reachable: it stays remembered, and the server forgets the device itself after 90 days.
    }
  }
}

/**
 * Save the device at the server again when it was saved more than 30 days ago, so alerts do not stop when the server forgets
 * the device after 90. It only renews a device this account saved and that still has its subscription and permission.
 */
export async function renewIfDue(
  me: string,
): Promise<"renewed" | "not-due" | "failed"> {
  const saved = readSaved();
  if (!saved || saved.account !== me) return "not-due";
  if (nowSecs() - saved.savedAt <= RENEW_AFTER_SECS) return "not-due";
  if (permissionNow() !== "granted") return "not-due";
  const registration = await registrationNow();
  const sub = registration
    ? await registration.pushManager.getSubscription().catch(() => null)
    : null;
  if (!sub || sub.endpoint !== saved.endpoint) return "not-due";
  try {
    await saveDevice(sub.toJSON());
    writeSaved({ ...saved, savedAt: nowSecs() });
    return "renewed";
  } catch {
    return "failed";
  }
}
