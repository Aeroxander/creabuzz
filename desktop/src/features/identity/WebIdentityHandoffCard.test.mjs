/**
 * Rendered coverage for `WebIdentityHandoffCard` — the settings surface of
 * the interim web → desktop identity handoff.
 *
 * Only the IPC boundary (`@/shared/api/tauriIdentity`), the relay socket
 * (`@/shared/api/relayClient`), and the profile-query module (for
 * `profileQueryKey`) are stubbed; the card, the controller
 * (`webIdentityHandoff.ts`), and React Query run production code. The
 * identity query cache lives on a real QueryClient so "cancel leaves the old
 * identity intact" is asserted against the exact cache App.tsx's replacement
 * sentinel watches.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

// Stub the three boundaries; behavior flows through globals the tests set.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@/shared/api/tauriIdentity" ||
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
          "export async function previewIdentityImport(nsec, password) {",
          "  return globalThis.__HANDOFF_TEST__.preview(nsec, password);",
          "}",
          "export async function importIdentity(nsec, password, expectedCurrentNpub) {",
          "  return globalThis.__HANDOFF_TEST__.importIdentity(",
          "    nsec, password, expectedCurrentNpub,",
          "  );",
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

const NSEC = "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz";
const CURRENT_NPUB =
  "npub1currentcurrentcurrentcurrentcurrentcurrentcurrentcurrent2q";
const CANDIDATE_NPUB =
  "npub1fu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4qgy4eg9";

const PREVIEW = {
  pubkey: "4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  npub: CANDIDATE_NPUB,
  currentNpub: CURRENT_NPUB,
  matchesCurrentIdentity: false,
};

const OLD_IDENTITY = {
  pubkey: "00000000000000000000000000000000000000000000000000000000000000aa",
  displayName: "old…",
  storage: "system-keyring",
  lost: false,
  locked: false,
  resetFailed: false,
};

const NEW_IDENTITY = {
  pubkey: PREVIEW.pubkey,
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

function mount() {
  const queryClient = new QueryClient({
    // gcTime Infinity is the only value `Removable.scheduleGc` does not arm a
    // timer for (isValidTimeout excludes it) — the default 5-minute GC
    // timeout would keep this test process alive long after the tests end.
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(["identity"], OLD_IDENTITY);
  queryClient.setQueryData(["profile"], { stale: true });

  const calls = { preview: [], importIdentity: [], disconnects: 0 };
  globalThis.__HANDOFF_TEST__ = {
    preview: async (nsec) => {
      calls.preview.push(nsec);
      if (calls.previewError) throw calls.previewError;
      return PREVIEW;
    },
    importIdentity: async (nsec, password, expectedCurrentNpub) => {
      calls.importIdentity.push([nsec, password, expectedCurrentNpub]);
      if (calls.importError) throw calls.importError;
      return NEW_IDENTITY;
    },
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

function setInput(view, value) {
  const input = q(view, '[data-testid="web-identity-input"]');
  const setter = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, value);
  act(() => {
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function openAndFill(view, nsec = NSEC) {
  click(q(view, '[data-testid="web-identity-open"]'));
  setInput(view, nsec);
}

async function runCheck(view) {
  await act(async () => {
    q(view, '[data-testid="web-identity-check"]').click();
  });
}

test("the card carries the interim-path honesty copy before any interaction", () => {
  const view = mount();
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /Use my web identity/);
    assert.match(
      q(view, '[data-testid="web-identity-interim-note"]').textContent,
      /passkey-native identity/i,
    );
    assert.match(
      q(view, '[data-testid="web-identity-interim-note"]').textContent,
      /app signing activation/,
      "the note must say what makes this handoff unnecessary",
    );
  } finally {
    view.unmount();
  }
});

test("cancelling a reviewed replacement leaves the old identity intact", async () => {
  const view = mount();
  try {
    await openAndFill(view);
    await runCheck(view);

    // Both identities are visible before confirming.
    const candidate = q(view, '[data-testid="web-identity-candidate"]');
    assert.match(candidate.textContent, new RegExp(CANDIDATE_NPUB));
    const warning = q(view, '[data-testid="web-identity-replace-warning"]');
    assert.match(warning.textContent, /replaces the identity/);
    assert.match(warning.textContent, new RegExp(CURRENT_NPUB));
    assert.match(
      q(view, '[data-testid="web-identity-passkey-note"]').textContent,
      /keys never leave the authenticator/,
    );

    click(q(view, '[data-testid="web-identity-cancel"]'));

    // The falsifiable guard: the mutating command was never reached, the
    // identity cache still holds the old identity (App.tsx's sentinel never
    // fires), and the relay socket was never torn down.
    assert.deepEqual(view.calls.importIdentity, []);
    assert.equal(view.calls.disconnects, 0);
    assert.deepEqual(view.queryClient.getQueryData(["identity"]), OLD_IDENTITY);
    assert.ok(q(view, '[data-testid="web-identity-open"]'), "panel closed");
    assert.equal(q(view, '[data-testid="web-identity-panel"]'), null);
  } finally {
    view.unmount();
  }
});

test("editing the key invalidates the reviewed preview", async () => {
  const view = mount();
  try {
    await openAndFill(view);
    await runCheck(view);
    assert.ok(q(view, '[data-testid="web-identity-replace"]'));

    setInput(view, `${NSEC}x`);

    assert.equal(
      q(view, '[data-testid="web-identity-replace"]'),
      null,
      "a stale preview must not stay confirmable after an edit",
    );
    assert.deepEqual(view.calls.importIdentity, []);
  } finally {
    view.unmount();
  }
});

test("confirming replaces the identity, fences the npub, and rekeys the cache", async () => {
  const view = mount();
  try {
    await openAndFill(view);
    await runCheck(view);

    await act(async () => {
      q(view, '[data-testid="web-identity-replace"]').click();
    });

    assert.deepEqual(
      view.calls.importIdentity,
      [[NSEC, undefined, CURRENT_NPUB]],
      "the import is fenced to the npub that was shown",
    );
    assert.equal(view.calls.disconnects, 1, "old socket torn down");
    assert.deepEqual(
      view.queryClient.getQueryData(["identity"]),
      NEW_IDENTITY,
      "identity query rekeyed — the sentinel rebuilds from this",
    );
    assert.equal(
      view.queryClient.getQueryData(["profile"]),
      undefined,
      "previous identity's profile cache dropped",
    );
    assert.match(
      q(view, '[data-testid="web-identity-done"]').textContent,
      new RegExp(CANDIDATE_NPUB),
    );
  } finally {
    view.unmount();
  }
});

test("an invalid key surfaces the parse error without importing", async () => {
  const view = mount();
  try {
    view.calls.previewError = new Error("Invalid private key: nope");
    await openAndFill(view, "not-a-key");
    await runCheck(view);

    const error = q(view, '[data-testid="web-identity-error"]');
    assert.ok(error, "error renders");
    assert.match(error.textContent, /Invalid private key/);
    assert.deepEqual(view.calls.importIdentity, []);
    assert.deepEqual(view.queryClient.getQueryData(["identity"]), OLD_IDENTITY);
  } finally {
    view.unmount();
  }
});
