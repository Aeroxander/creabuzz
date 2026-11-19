import { describe, expect, it } from "vitest";
import { deploymentsEnv } from "./deployments-env";
import { potNetwork } from "./pot-network";

// What `script/DeployPot.s.sol` writes, with the public anvil addresses.
const FILE = JSON.stringify({
  admin: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  chainId: 31337,
  feeBps: 200,
  launcher: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  parts: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  platform: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  quote: "0x5FbDB2315678afecb367f032d93f642f64180aa3",
  unit: 604800,
});

describe("the network a build is for", () => {
  it("comes from the deployments file, and the build's own environment wins over it", () => {
    const fromFile = deploymentsEnv("pot-31337.json", FILE, {});
    expect(fromFile).toEqual({
      VITE_CREATON_CHAIN_ID: "31337",
      VITE_CREATON_LAUNCHER: "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0",
      VITE_CREATON_DOLLAR: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
    });
    expect(potNetwork(fromFile)).toMatchObject({
      chainId: 31337,
      name: "Local test network",
      playMoney: true,
    });
    // A value set by hand is never overwritten by the file.
    const mixed = deploymentsEnv("pot-31337.json", FILE, {
      VITE_CREATON_CHAIN_ID: "11155111",
    });
    expect(mixed.VITE_CREATON_CHAIN_ID).toBeUndefined();
    expect(mixed.VITE_CREATON_LAUNCHER).toBeDefined();
  });

  it("stops the build, naming the file, when it cannot be used", () => {
    expect(() => deploymentsEnv("x.json", "{not json", {})).toThrow(
      /x\.json is not JSON/,
    );
    expect(() => deploymentsEnv("x.json", "{}", {})).toThrow(
      /x\.json is not a deployments file/,
    );
    expect(() =>
      deploymentsEnv("x.json", JSON.stringify({ chainId: 1 }), {}),
    ).toThrow(/not a deployments file/);
  });

  it("a build that names no network has none, and offers no money step", () => {
    expect(potNetwork({})).toBeNull();
    expect(potNetwork({ VITE_CREATON_CHAIN_ID: "31337" })).toBeNull();
  });
});
