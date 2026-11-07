/**
 * The people of the screen audit's world (`scripts/web-screen-audit.sh`): fixed keys, so the capture can sign in as
 * any of them, and each with one of Anvil's dev accounts as their wallet (the same split as the contributor journeys:
 * the founder is account 0, the reviewers 1 and 2, the contributor 3, the newcomer 4), signed for in the page by a key
 * wallet (`tests/helpers/key-wallet.ts`), as the economy journey's people are.
 */
import { getPublicKey } from "nostr-tools/pure";

import { keyFromHex } from "./social-helpers.mjs";

export const CAST = {
  frida: {
    key: "d1".repeat(32),
    name: "Frida Lund",
    about: "Started Creaton. Posts an update every Friday.",
    wallet: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    walletKey:
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
  rui: {
    key: "d2".repeat(32),
    name: "Rui Costa",
    about: "Reviews work on Creaton. Teaches design in Porto.",
    wallet: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    walletKey:
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  },
  rae: {
    key: "d3".repeat(32),
    name: "Rae Kim",
    about: "Reviews work on Creaton.",
    wallet: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    walletKey:
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  },
  cora: {
    key: "d4".repeat(32),
    name: "Cora Mendes",
    about: "Writes guides people actually read.",
    wallet: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    walletKey:
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  },
  nia: {
    key: "d5".repeat(32),
    name: "Nia Patel",
    about: "New here. Into community gardens.",
    wallet: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    walletKey:
      "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  },
  mo: {
    key: "d6".repeat(32),
    name: "Mo Haddad",
    about: "Keeps the supporters board friendly.",
    wallet: null,
    walletKey: null,
  },
};

export const pubkeyOfCast = (name) => getPublicKey(keyFromHex(CAST[name].key));
