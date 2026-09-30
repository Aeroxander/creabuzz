/**
 * Rendered coverage for the NeedsMeApprovalCard states (P0 operator loop, part 1).
 *
 * The card is the inline resolution surface for kind:46010 "needs me" requests.
 * These tests pin the states an operator can see: pending (buttons + payload),
 * resolving (pending-state button labels), decided (pill, no actions), inline
 * publish errors next to the buttons (never a toast for on-screen state), the
 * amber aging treatment for 24h+ waits, and identity resolution with the
 * PubKey fallback.
 *
 * Only the profile-hooks boundary is stubbed; the card, badge, and tone
 * mapping all run their production code.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

// The card resolves requester identity through the shared profile hooks, which
// hit the relay client. Stub the hook boundary; tests set the returned profiles
// via a global so both the "no profile" (PubKey fallback) and "resolved name"
// paths are reachable.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/features/profile/hooks") {
      return {
        shortCircuit: true,
        url: "buzz-needsme-stub:profile-hooks",
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "buzz-needsme-stub:profile-hooks") {
      return {
        format: "module",
        shortCircuit: true,
        source:
          "export function useUsersBatchQuery() {\n" +
          "  return { data: globalThis.__NEEDS_ME_TEST_PROFILES__ ?? undefined };\n" +
          "}\n",
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
  unobserve() {}
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
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const SUBJECT = "3".repeat(64);

// Profile-hook stub state: tests set globalThis.__NEEDS_ME_TEST_PROFILES__.
const TOKEN_HASH = "a".repeat(64);

function budgetApproval(overrides = {}) {
  return {
    id: "approval-event-1",
    tokenHash: TOKEN_HASH,
    subjectPubkey: SUBJECT,
    kind: "budget-overrun",
    counterType: "spend",
    window: "day",
    limit: 500,
    createdAt: Math.floor(Date.now() / 1000) - 3600,
    ...overrides,
  };
}

let React;
let act;
let createRoot;
let NeedsMeApprovalCard;

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ NeedsMeApprovalCard } = await import("./NeedsMeApprovalCard.tsx"));
});

after(() => dom.window.close());

function mount(cardProps) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(NeedsMeApprovalCard, cardProps));
  });
  return {
    container,
    setProps(next) {
      act(() => {
        root.render(React.createElement(NeedsMeApprovalCard, next));
      });
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

const q = (container, selector) => container.querySelector(selector);

test("pending budget overrun renders type badge, subject identity, status pill, and payload", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval(),
    status: "pending",
    onResolve: () => {},
    testId: "card",
  });
  try {
    assert.ok(q(view.container, '[data-testid="card"]'));
    assert.match(
      view.container.textContent ?? "",
      /Budget overrun/,
      "type badge names the request kind",
    );
    assert.match(
      view.container.textContent ?? "",
      /Pending/,
      "status pill shows pending",
    );
    const approve = q(view.container, '[data-testid="card-approve"]');
    const deny = q(view.container, '[data-testid="card-deny"]');
    assert.ok(approve, "Approve button renders");
    assert.ok(deny, "Deny button renders");
    assert.deepEqual(
      approve.getAttribute("aria-label"),
      `Approve the budget overrun request from ${SUBJECT}`,
    );
    // Payload rows are machine values in monospace.
    const payload = view.container.textContent ?? "";
    assert.match(payload, /Counter/);
    assert.match(payload, /spend/);
    assert.match(payload, /day/);
    assert.match(payload, /500/);
    assert.match(payload, /Reference/);
    // No profile → the PubKey chip fallback shows the truncated key in the
    // app-wide npub display convention.
    assert.match(
      view.container.textContent ?? "",
      /npub1xve…z8z4/,
      "PubKey chip fallback renders the truncated key",
    );
  } finally {
    view.unmount();
  }
});

test("clicking Approve flips the label to its pending state and disables both buttons", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const decisions = [];
  const view = mount({
    approval: budgetApproval(),
    status: "pending",
    onResolve: (approval, approved) =>
      decisions.push([approval.tokenHash, approved]),
    testId: "card",
  });
  try {
    const approve = q(view.container, '[data-testid="card-approve"]');
    act(() => {
      approve.dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true }),
      );
    });
    assert.deepEqual(decisions, [[TOKEN_HASH, true]]);
    assert.match(
      q(view.container, '[data-testid="card-approve"]').textContent,
      /Approving/,
    );
    assert.ok(q(view.container, '[data-testid="card-approve"]').disabled);
    assert.ok(q(view.container, '[data-testid="card-deny"]').disabled);
  } finally {
    view.unmount();
  }
});

test("a publish failure renders an inline alert next to the buttons, not a toast", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval(),
    status: "pending",
    onResolve: () => {},
    error: "Only the community owner can resolve this approval.",
    testId: "card",
  });
  try {
    const alert = q(view.container, '[data-testid="card-error"]');
    assert.ok(alert, "inline error renders");
    assert.deepEqual(alert.getAttribute("role"), "alert");
    assert.match(
      alert.textContent ?? "",
      /Only the community owner can resolve this approval/,
    );
    assert.ok(
      q(view.container, '[data-testid="card-approve"]'),
      "buttons stay for retry",
    );
  } finally {
    view.unmount();
  }
});

test("granted status shows the approved pill and no decision buttons", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval(),
    status: "granted",
    testId: "card",
  });
  try {
    const pill = q(view.container, '[data-testid="card-status"]');
    assert.deepEqual(pill.getAttribute("data-status-variant"), "approved");
    assert.match(pill.textContent ?? "", /Approved/);
    assert.equal(q(view.container, '[data-testid="card-approve"]'), null);
    assert.equal(q(view.container, '[data-testid="card-deny"]'), null);
    assert.match(view.container.textContent ?? "", /approved this request/);
  } finally {
    view.unmount();
  }
});

test("denied status maps to the blocking tone pill", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval(),
    status: "denied",
    testId: "card",
  });
  try {
    const pill = q(view.container, '[data-testid="card-status"]');
    assert.deepEqual(pill.getAttribute("data-status-variant"), "denied");
  } finally {
    view.unmount();
  }
});

test("pending requests older than 24h render the amber aging treatment", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval({
      createdAt: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
    }),
    status: "pending",
    isAging: true,
    testId: "card",
  });
  try {
    assert.deepEqual(
      q(view.container, '[data-testid="card"]').getAttribute("data-aging"),
      "true",
    );
    assert.match(view.container.textContent ?? "", /waiting over a day/);
    assert.match(
      q(view.container, '[data-testid="card"]').className,
      /status-waiting/,
      "aging uses the waiting tone tokens",
    );
  } finally {
    view.unmount();
  }
});

test("workflow requests show the Workflow badge and no budget payload", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  const view = mount({
    approval: budgetApproval({
      kind: "workflow",
      counterType: null,
      window: null,
      limit: null,
      subjectPubkey: null,
    }),
    status: "pending",
    testId: "card",
  });
  try {
    assert.match(view.container.textContent ?? "", /Workflow/);
    assert.doesNotMatch(view.container.textContent ?? "", /Counter/);
    assert.match(view.container.textContent ?? "", /Unknown requester/);
  } finally {
    view.unmount();
  }
});

test("a resolved profile name replaces the PubKey chip fallback", () => {
  globalThis.__NEEDS_ME_TEST_PROFILES__ = undefined;
  globalThis.__NEEDS_ME_TEST_PROFILES__ = {
    profiles: {
      [SUBJECT]: {
        displayName: "Budget Agent",
        avatarUrl: null,
        nip05Handle: null,
        ownerPubkey: null,
        isAgent: true,
      },
    },
    missing: [],
  };
  const view = mount({
    approval: budgetApproval(),
    status: "pending",
    testId: "card",
  });
  try {
    assert.match(view.container.textContent ?? "", /Requested by/);
    assert.match(view.container.textContent ?? "", /Budget Agent/);
  } finally {
    view.unmount();
  }
});
