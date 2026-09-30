/**
 * Rendered contract coverage for the Getting-started checklist.
 *
 * Rule 1 binding: a step with no sound detector ("Mention an agent") must
 * render as an action link — never a checkbox that can claim a done/todo
 * state the app cannot verify. Detected steps must only show "Done" when the
 * production evaluation (evaluateGettingStarted via useGettingStartedSteps)
 * says so — the query boundaries are stubbed, everything else is production.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";
import { JSDOM } from "jsdom";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = new Map([
      ["@/app/AppShellContext", "buzz-gs-stub:app-shell"],
      ["@/app/navigation/useAppNavigation", "buzz-gs-stub:app-navigation"],
      ["@/features/channels/hooks", "buzz-gs-stub:channels-hooks"],
      ["@/features/home/hooks", "buzz-gs-stub:home-hooks"],
      ["@/features/agents/hooks", "buzz-gs-stub:agents-hooks"],
    ]);
    const url = stubs.get(specifier);
    if (url) {
      return { shortCircuit: true, url };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const sources = {
      "buzz-gs-stub:app-shell":
        "export function useAppShell() {\n" +
        "  return {\n" +
        "    openBrowseChannels() { globalThis.__GS_TEST_ACTIONS__.push('browse-channels'); },\n" +
        "    openCreateChannel() { globalThis.__GS_TEST_ACTIONS__.push('create-channel'); },\n" +
        "  };\n" +
        "}\n",
      "buzz-gs-stub:app-navigation":
        "export function useAppNavigation() {\n" +
        "  return {\n" +
        "    goAgents() { globalThis.__GS_TEST_ACTIONS__.push('open-agents'); },\n" +
        "    goChannel(id) { globalThis.__GS_TEST_ACTIONS__.push('open-channel:' + id); },\n" +
        "    goWorkflows() { globalThis.__GS_TEST_ACTIONS__.push('open-workflows'); },\n" +
        "  };\n" +
        "}\n",
      "buzz-gs-stub:channels-hooks":
        "export function useChannelsQuery() {\n" +
        "  return { data: globalThis.__GS_TEST_CHANNELS__ ?? [] };\n" +
        "}\n",
      "buzz-gs-stub:home-hooks":
        "export function useHomeFeedQuery() {\n" +
        "  return { data: globalThis.__GS_TEST_FEED__ };\n" +
        "}\n",
      "buzz-gs-stub:agents-hooks":
        "export function useManagedAgentsQuery() {\n" +
        "  return { data: globalThis.__GS_TEST_AGENTS__ ?? [] };\n" +
        "}\n",
    };
    const source = sources[url];
    if (source !== undefined) {
      return { format: "module", shortCircuit: true, source };
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

const SELF = "A".repeat(64);
globalThis.__GS_TEST_ACTIONS__ = [];

let React;
let act;
let createRoot;
let GettingStartedChecklist;
let GettingStartedStepsList;

before(async () => {
  ({ default: React, act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ GettingStartedChecklist, GettingStartedStepsList } = await import(
    "./GettingStartedChecklist.tsx"
  ));
});

after(() => dom.window.close());

function setWorld({ agents = [], channels = [], feed = undefined } = {}) {
  globalThis.__GS_TEST_AGENTS__ = agents;
  globalThis.__GS_TEST_CHANNELS__ = channels;
  globalThis.__GS_TEST_FEED__ = feed;
}

function feedItem(overrides = {}) {
  return {
    id: "evt-1",
    kind: 40002,
    pubkey: SELF,
    content: "hello",
    createdAt: 1,
    channelId: "channel-1",
    channelName: "general",
    tags: [],
    category: "activity",
    ...overrides,
  };
}

function feedResponse(items) {
  return {
    feed: {
      mentions: [],
      needsAction: [],
      activity: items,
      agentActivity: [],
    },
    meta: { since: 0, total: items.length, generatedAt: 0 },
  };
}

function mount(element) {
  const container = dom.window.document.createElement("div");
  dom.window.document.body.replaceChildren(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
    },
  };
}

function stepRow(container, id) {
  const row = container.querySelector(
    `[data-testid="getting-started-step-${id}"]`,
  );
  assert.ok(row, `missing step row ${id}`);
  return row;
}

test("undetected steps render as action links, never checkboxes", () => {
  setWorld();
  const view = mount(
    React.createElement(GettingStartedStepsList, { currentPubkey: SELF }),
  );

  const mentionRow = stepRow(view.container, "mention-agent");
  assert.doesNotMatch(mentionRow.textContent ?? "", /Done|Not done yet/);
  assert.equal(
    mentionRow.querySelectorAll('[title="Done"], [title="Not done yet"]')
      .length,
    0,
  );
  assert.ok(
    mentionRow.querySelector(
      '[data-testid="getting-started-step-mention-agent-action"]',
    ),
    "mention-agent must still expose its working affordance",
  );
  view.unmount();
});

test("detected steps only claim done when the production evaluation says so", () => {
  setWorld({
    channels: [{ id: "channel-1", name: "general", channelType: "text" }],
    agents: [{ pubkey: "agent-1" }],
    feed: feedResponse([
      feedItem(),
      feedItem({ id: "evt-2", kind: 43001, category: "activity" }),
    ]),
  });
  const view = mount(
    React.createElement(GettingStartedStepsList, { currentPubkey: SELF }),
  );

  for (const id of ["open-channel", "say-hello", "add-agent", "run-workflow"]) {
    assert.match(stepRow(view.container, id).textContent ?? "", /Done/);
  }
  // Soundness spot-check: someone else's message is not "say hello" done.
  setWorld({
    channels: [{ id: "channel-1", name: "general", channelType: "text" }],
    feed: feedResponse([feedItem({ pubkey: "B".repeat(64) })]),
  });
  const otherView = mount(
    React.createElement(GettingStartedStepsList, { currentPubkey: SELF }),
  );
  assert.doesNotMatch(
    stepRow(otherView.container, "say-hello").textContent ?? "",
    /Done/,
  );
  view.unmount();
  otherView.unmount();
});

test("the home card exposes dismissal and step affordances", () => {
  setWorld();
  let dismissed = 0;
  const view = mount(
    React.createElement(GettingStartedChecklist, {
      currentPubkey: SELF,
      onDismiss: () => {
        dismissed += 1;
      },
    }),
  );

  assert.ok(
    view.container.querySelector('[data-testid="getting-started-card"]'),
  );
  const dismiss = view.container.querySelector(
    '[data-testid="getting-started-dismiss"]',
  );
  assert.ok(dismiss);
  assert.equal(
    dismiss.getAttribute("aria-label"),
    "Hide getting started checklist",
  );
  dismiss.click();
  assert.equal(dismissed, 1);

  globalThis.__GS_TEST_ACTIONS__.length = 0;
  const createStepAction = view.container.querySelector(
    '[data-testid="getting-started-step-open-channel-action"]',
  );
  assert.ok(createStepAction);
  createStepAction.click();
  assert.deepEqual(globalThis.__GS_TEST_ACTIONS__, ["create-channel"]);
  view.unmount();
});
