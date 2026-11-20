/**
 * A browser's push pieces, faked for the tests (a test browser has no push service): the worker's registration with its push
 * manager, the notification permission, and the window's `PushManager`. Everything the card does to the browser is recorded.
 */
import { vi } from "vitest";

/** The server's key as base64url, made from known bytes: 0x04 then 64 more. */
export const KEY_BYTES = Uint8Array.from([
  4,
  ...Array.from({ length: 64 }, (_, i) => i + 1),
]);
export const KEY = Buffer.from(KEY_BYTES).toString("base64url");

export interface FakeSub {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: ReturnType<typeof vi.fn>;
}

let counter = 0;
export function makeSub(
  key: Uint8Array = KEY_BYTES,
  endpoint?: string,
): FakeSub {
  counter += 1;
  const at =
    endpoint ?? `https://fcm.googleapis.com/fcm/send/device-${counter}`;
  return {
    endpoint: at,
    options: { applicationServerKey: key.slice().buffer },
    toJSON: () => ({
      endpoint: at,
      keys: { p256dh: "p256dh-key", auth: "auth-secret" },
    }),
    unsubscribe: vi.fn(async () => true),
  };
}

export interface Fake {
  permission: NotificationPermission;
  /** What the browser's own question answers. */
  answer: NotificationPermission;
  sub: FakeSub | null;
  asked: number;
  subscribed: {
    userVisibleOnly?: boolean;
    applicationServerKey?: Uint8Array;
  }[];
  /** When set, `subscribe` fails. */
  subscribeFails: boolean;
  /** No worker is registered (`getRegistration` says none, `ready` never answers). */
  noWorker: boolean;
}

export function installBrowser(over: Partial<Fake> = {}): Fake {
  const fake: Fake = {
    permission: "default",
    answer: "granted",
    sub: null,
    asked: 0,
    subscribed: [],
    subscribeFails: false,
    noWorker: false,
    ...over,
  };
  const pushManager = {
    getSubscription: async () => fake.sub,
    subscribe: async (options: {
      userVisibleOnly?: boolean;
      applicationServerKey?: Uint8Array;
    }) => {
      fake.subscribed.push(options);
      if (fake.subscribeFails) throw new Error("push service unreachable");
      fake.sub = makeSub(options.applicationServerKey ?? KEY_BYTES);
      return fake.sub;
    },
  };
  const registration = { pushManager };
  vi.stubGlobal("PushManager", function PushManager() {});
  Object.defineProperty(window, "PushManager", {
    value: function PushManager() {},
    configurable: true,
    writable: true,
  });
  vi.stubGlobal("Notification", {
    get permission() {
      return fake.permission;
    },
    requestPermission: async () => {
      fake.asked += 1;
      fake.permission = fake.answer;
      return fake.answer;
    },
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => (fake.noWorker ? undefined : registration),
      ready: fake.noWorker
        ? new Promise(() => undefined)
        : Promise.resolve(registration),
    },
  });
  return fake;
}

export function removeBrowser() {
  vi.unstubAllGlobals();
  // biome-ignore lint/suspicious/noExplicitAny: removing a property a test added to the window
  delete (window as any).PushManager;
  // biome-ignore lint/suspicious/noExplicitAny: removing a property a test added to the navigator
  delete (navigator as any).serviceWorker;
}
