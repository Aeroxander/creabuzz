// Where the launch card shows on the project page: for the founder of a project that is not on the network yet, and nowhere
// else; and what the Money tab says before and just after a launch (the server's record may take a moment, and no zeros are
// shown meanwhile).
import { applyServerSettings } from "@creaton/core/client/server-settings.ts";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COORDINATE,
  installWallet,
  projectEvent,
  SERVER,
  serve,
  wrap,
} from "../../../tests/helpers/money-harness";
import {
  chainIdentityV2,
  FOUNDER_EVM,
} from "../../../tests/helpers/numbers-v2-fixture";
import { nameTheNetwork, numbersFor } from "../../../tests/helpers/pot-harness";
import { ProjectPage } from "../project/ProjectPage";
import { projectRef } from "../project/project-record";

const [, FOUNDER, ID] = COORDINATE.split(":");
const STRANGER = "c".repeat(64);

vi.mock(
  "../../lib/relay",
  async () => (await import("../../../tests/helpers/money-harness")).relayMock,
);
let viewer = FOUNDER as string;
vi.mock("../../lib/account", () => ({
  useAccount: () => ({ pubkey: viewer, locked: false }),
}));
vi.mock("@tanstack/react-router", async (actual) => ({
  ...(await actual<object>()),
  Link: ({ children }: { children: ReactNode }) => <a href="/p">{children}</a>,
  useNavigate: () => () => undefined,
  useRouter: () => ({ history: { back: () => undefined }, navigate: vi.fn() }),
  useRouterState: () => ({ location: { pathname: "/p", search: "" } }),
}));

const numbers = numbersFor();

function page(options: { chainKey?: boolean; author?: string } = {}) {
  const chainKey =
    options.chainKey === false ? "" : chainIdentityV2(COORDINATE).key;
  const event = projectEvent({
    author: options.author ?? FOUNDER,
    id: ID,
    name: "Lantern",
    chainKey,
  });
  if (!chainKey) event.tags = event.tags.filter((t) => t[0] !== "chain-key");
  serve([event]);
  wrap(
    <ProjectPage
      projectRef={projectRef({ id: ID, author: options.author ?? FOUNDER })}
    />,
  );
}
const openMoney = async () =>
  fireEvent.mouseDown(await screen.findByRole("tab", { name: "Money" }), {
    button: 0,
  });

beforeEach(() => {
  viewer = FOUNDER;
  applyServerSettings({ investing: true, self: SERVER });
  installWallet({ account: FOUNDER_EVM });
  nameTheNetwork(numbers);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  applyServerSettings(null);
});

describe("the launch card on the project page", () => {
  it("is shown to the founder of a project that is not on the network, and the Money tab says it is not open yet", async () => {
    page({ chainKey: false });
    expect((await screen.findByTestId("launch-card")).textContent).toMatch(
      /Open Lantern to backers/,
    );
    await openMoney();
    const none = await screen.findByTestId("money-none");
    expect(none.textContent).toMatch(/Not open to backers yet/);
    expect(none.textContent).toMatch(/Nobody can back this project yet/);
    expect(screen.queryByTestId("project-money")).toBeNull();
  });

  it("is not shown to anyone else", async () => {
    viewer = STRANGER;
    page({ chainKey: false });
    await screen.findByTestId("project-name");
    expect(screen.queryByTestId("launch-card")).toBeNull();
  });

  it("is not shown once the page names its launch, and then the Money tab waits for the server without showing any figure", async () => {
    page();
    await screen.findByTestId("project-name");
    expect(screen.queryByTestId("launch-card")).toBeNull();
    await openMoney();
    const none = await screen.findByTestId("money-none");
    expect(none.textContent).toMatch(/No numbers yet/);
    expect(none.textContent).toMatch(
      /looks again by itself for a couple of minutes/,
    );
    expect(none.textContent).not.toMatch(/0\.00|\b0 dollars/);
  });

  it("is not shown when the server has investing off", async () => {
    applyServerSettings({ investing: false, self: SERVER });
    page({ chainKey: false });
    await screen.findByTestId("project-name");
    expect(screen.queryByTestId("launch-card")).toBeNull();
  });

  it("is not shown in a build that names no network", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("VITE_CREATON_LAUNCHER", "");
    page({ chainKey: false });
    await screen.findByTestId("project-name");
    expect(screen.queryByTestId("launch-card")).toBeNull();
  });
});
