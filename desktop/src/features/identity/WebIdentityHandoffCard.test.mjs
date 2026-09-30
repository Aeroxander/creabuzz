/**
 * Rendered coverage for `WebIdentityHandoffCard` — the settings surface of
 * the browser → desktop account handoff.
 *
 * Only the IPC boundary (`@/shared/api/tauriIdentity`), the deep-link event
 * boundary (`@tauri-apps/api/event`), the relay socket
 * (`@/shared/api/relayClient`), and the profile-query module (for
 * `profileQueryKey`) are stubbed; the card, the controller
 * (`webIdentityHandoff.ts`), and React Query run production code. The
 * identity query cache lives on a real QueryClient so "the linked account is
 * adopted" is asserted against the exact cache App.tsx's replacement
 * sentinel watches.
 *
 * Falsifiability: the paste-affordance guard (no key input exists at all)
 * and the request-id fence (a stale result must not adopt an account) are
 * both production-bound here.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

// Stub the four boundaries; behavior flows through globals the tests set.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@/shared/api/tauriIdentity" ||
      specifier === "@tauri-apps/api/event" ||
      specifier === "@/shared/api/relayClient" ||
      specifier === "@/features/profile/hooks"
    ) {
      return { shortCircuit: true, url: `buzz-handoff-stub:${specifier}` };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "buzz-handoff-stub:@/shared/api/tauriIdentity") {
      return {
        format: "module",
        shortCircuit: true,
        source: [
          "export async function startIdentityLink() {",
          "  return globalThis.__HANDOFF_TEST__.start();",
          "}",
          "export async function cancelIdentityLink() {",
          "  return globalThis.__HANDOFF_TEST__.cancel();",
          "}",
          "export async function takeIdentityLinkResult() {",
          "  return globalThis.__HANDOFF_TEST__.take();",
          "}",
          "export async function getIdentity() {",
          "  return globalThis.__HANDOFF_TEST__.getIdentity();",
          "}",
        ].join("\n"),
      };
    }
    if (url === "buzz-handoff-stub:@tauri-apps/api/event") {
      return {
        format: "module",
        shortCircuit: true,
        source: [
          "export function listen(name, callback) {",
          "  globalThis.__HANDOFF_TEST__.listeners.push({ name, callback });",
          "  return Promise.resolve(() => {});",
          "}",
        ].join("\n"),
      };
    }
    if (url === "buzz-handoff-stub:@/shared/api/relayClient") {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export const relayClient = {\n" +
          "  disconnect() {\n" +
          "    globalThis.__HANDOFF_TEST__.disconnects += 1;\n" +
          "  },\n" +
          "};\n",
      };
    }
    if (url === "buzz-handoff-stub:@/features/profile/hooks") {
      return {
        format: "module",
        shortCircuit: true,
        source: 'export const profileQueryKey = ["profile"];\n',
      };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

class NoopObserver {
  disconnect() {}
  observe() {}
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, {
  IntersectionObserver: NoopObserver,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: NoopObserver,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  self: dom.window,
  window: dom.window,
});
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (
    !(key in globalThis) &&
    (key.startsWith("HTML") ||
      key.startsWith("SVG") ||
      ["Element", "Node", "NodeList", "Event", "CustomEvent"].includes(key))
  ) {
    const value = dom.window[key];
    if (value !== undefined) globalThis[key] = value;
  }
}
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: dom.window.navigator,
  writable: true,
});
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
dom.window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
globalThis.matchMedia = dom.window.matchMedia;
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(() => callback(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const REQUEST_ID = "11111111-1111-1111-1111-111111111111";
const STALE_ID = "99999999-9999-9999-9999-999999999999";
const LINK_URL = "https://app.example.com/link-device?pub=aa&nonce=bb&cb=x";
const NPUB = "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9";

const OLD_IDENTITY = {
  pubkey: "00000000000000000000000000000000000000000000000000000000000000aa",
  displayName: "old…",
  storage: "system-keyring",
  lost: false,
  locked: false,
  resetFailed: false,
};

const NEW_IDENTITY = {
  pubkey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  displayName: "4f355b…71aa",
  storage: "system-keyring",
  lost: false,
  locked: false,
  resetFailed: false,
};

let React;
let act;
let createRoot;
let QueryClient;
let QueryClientProvider;
let WebIdentityHandoffCard;

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  ));
  ({ WebIdentityHandoffCard } = await import("./WebIdentityHandoffCard.tsx"));
});

after(() => dom.window.close());

function mount(options = {}) {
  const queryClient = new QueryClient({
    // gcTime Infinity is the only value `Removable.scheduleGc` does not arm a
    // timer for — the default 5-minute GC timeout would keep this test
    // process alive long after the tests end.
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(["identity"], OLD_IDENTITY);
  queryClient.setQueryData(["profile"], { stale: true });

  const calls = {
    start: [],
    cancel: 0,
    disconnects: 0,
    listeners: [],
  };
  globalThis.__HANDOFF_TEST__ = {
    start: async () => {
      calls.start.push(true);
      if (options.startError) throw options.startError;
      return { id: REQUEST_ID, url: LINK_URL };
    },
    cancel: async () => {
      calls.cancel += 1;
    },
    take: async () => options.queuedResult ?? null,
    getIdentity: async () => NEW_IDENTITY,
    listeners: calls.listeners,
    get disconnects() {
      return calls.disconnects;
    },
    set disconnects(value) {
      calls.disconnects = value;
    },
  };

  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(WebIdentityHandoffCard),
      ),
    );
  });
  return {
    calls,
    container,
    queryClient,
    emit: (result) => {
      for (const { name, callback } of calls.listeners) {
        if (name === "deep-link-identity") callback({ payload: result });
      }
    },
    unmount: () => act(() => root.unmount()),
  };
}

const q = (view, selector) => view.container.querySelector(selector);

function click(element) {
  act(() => {
    element.dispatchEvent(
      new dom.window.MouseEvent("click", { bubbles: true }),
    );
  });
}

test("the card has no paste affordance at all", () => {
  const view = mount();
  assert.equal(q(view, '[data-testid="web-identity-input"]'), null);
  assert.equal(view.container.querySelector("input"), null);
  assert.equal(view.container.querySelector("textarea"), null);
  // The primary action is a real button — keyboard and pointer first-class.
  const open = q(view, '[data-testid="web-identity-open"]');
  assert.equal(open.tagName, "BUTTON");
  assert.equal(open.textContent, "Sign in with browser");
  // Technical detail is collapsed, not main copy.
  assert.ok(q(view, '[data-testid="web-identity-technical"]'));
  view.unmount();
});

test("starting a sign-in shows the waiting state", async () => {
  const view = mount();
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  assert.equal(view.calls.start.length, 1);
  const waiting = q(view, '[data-testid="web-identity-waiting"]');
  assert.ok(waiting);
  assert.equal(waiting.getAttribute("role"), "status");
  assert.ok(q(view, '[data-testid="web-identity-cancel"]'));
  view.unmount();
});

test("the matching result links the account and re-scopes the identity query", async () => {
  const view = mount();
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  await act(async () => {
    view.emit({ id: REQUEST_ID, status: "linked", npub: NPUB });
  });
  const done = q(view, '[data-testid="web-identity-done"]');
  assert.ok(done);
  assert.equal(done.getAttribute("role"), "status");
  assert.ok(done.textContent.includes(NPUB));
  assert.equal(view.calls.disconnects, 1);
  // deepEqual: React Query's structural sharing rebuilds the cached object.
  assert.deepEqual(view.queryClient.getQueryData(["identity"]), NEW_IDENTITY);
  assert.equal(
    view.queryClient.getQueryData(["profile"]),
    undefined,
    "stale profile cache is dropped on link",
  );
  view.unmount();
});

test("a stale result never adopts an account", async () => {
  const view = mount();
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  await act(async () => {
    view.emit({ id: STALE_ID, status: "linked", npub: NPUB });
  });
  assert.ok(q(view, '[data-testid="web-identity-waiting"]'));
  assert.equal(q(view, '[data-testid="web-identity-done"]'), null);
  assert.equal(view.calls.disconnects, 0);
  assert.deepEqual(view.queryClient.getQueryData(["identity"]), OLD_IDENTITY);
  view.unmount();
});

test("a rejection says what happened and what to do next", async () => {
  const view = mount();
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  await act(async () => {
    view.emit({ id: REQUEST_ID, status: "rejected", reason: "expired" });
  });
  const error = q(view, '[data-testid="web-identity-error"]');
  assert.ok(error);
  assert.equal(error.getAttribute("role"), "alert");
  assert.ok(error.textContent.includes("expired"));
  assert.ok(q(view, '[data-testid="web-identity-retry"]'));
  // Retry drives the same production start path again.
  click(q(view, '[data-testid="web-identity-retry"]'));
  await act(async () => {});
  assert.equal(view.calls.start.length, 2);
  view.unmount();
});

test("cancel abandons the request and resets the surface", async () => {
  const view = mount();
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  click(q(view, '[data-testid="web-identity-cancel"]'));
  await act(async () => {});
  assert.equal(view.calls.cancel, 1);
  assert.ok(q(view, '[data-testid="web-identity-open"]'));
  assert.equal(q(view, '[data-testid="web-identity-waiting"]'), null);
  view.unmount();
});

test("a result queued before mounting is picked up", async () => {
  const view = mount({
    queuedResult: { id: REQUEST_ID, status: "linked", npub: NPUB },
  });
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  await act(async () => {});
  assert.ok(q(view, '[data-testid="web-identity-done"]'));
  view.unmount();
});

test("a failed start tells the user what to do", async () => {
  const view = mount({
    startError: new Error("Set BUZZ_WEB_HOST to your web app host"),
  });
  click(q(view, '[data-testid="web-identity-open"]'));
  await act(async () => {});
  const error = q(view, '[data-testid="web-identity-error"]');
  assert.ok(error);
  assert.ok(error.textContent.includes("BUZZ_WEB_HOST"));
  view.unmount();
});
