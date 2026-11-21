/**
 * The passkey account's address worked out on the device, from the passkey's own public key, with no network call. The
 * Kernel 0.3.3 factory makes the account as a Solady ERC-1967 proxy of one shared implementation at a CREATE2 address
 * whose salt is `keccak256(initializeCalldata ++ salt)`, so the address is a pure function of the owner key and the factory's
 * two public constants. The app compares this with what its node says (`getAddress` on the factory) and shows an address
 * only when the two are the same: a node that lies about it could otherwise show a deposit address nobody controls.
 */
import { keccak256 } from "./userop.ts";
import {
  encodeKernel033Initialize,
  KERNEL_0_3_3_ZERO_SALT,
  KERNEL_FACTORY_0_3_3,
} from "./kernel033.ts";

/** The Kernel 0.3.3 implementation the deployed factory clones (`factory.implementation()`; the fixture of the phone loop sets it). */
const KERNEL_IMPLEMENTATION_0_3_3 =
  "0xd6cedde84be40893d153be9d467cd6ad37875b28";

/** Solady's ERC-1967 proxy creation code, in three parts around the 20-byte implementation address. */
const PROXY_PREFIX = "603d3d8160223d3973";
const PROXY_SUFFIX =
  "60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The account address for a passkey's public key (x and y of the P-256 point), in lower case. */
export function kernel033AddressLocal(params: {
  pubKeyX: bigint;
  pubKeyY: bigint;
  /** The deployed passkey validator (default: the deployed one the app uses). */
  validationId?: string | undefined;
  factory?: string | undefined;
  implementation?: string | undefined;
  salt?: string | undefined;
}): string {
  const factory = params.factory ?? KERNEL_FACTORY_0_3_3;
  const implementation = params.implementation ?? KERNEL_IMPLEMENTATION_0_3_3;
  const salt = params.salt ?? KERNEL_0_3_3_ZERO_SALT;
  if (!ADDRESS.test(factory) || !ADDRESS.test(implementation))
    throw new Error("kernel033: the factory and implementation are addresses");
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt))
    throw new Error("kernel033: the salt is 32 bytes");
  const initData = encodeKernel033Initialize({
    pubKeyX: params.pubKeyX,
    pubKeyY: params.pubKeyY,
    validationId: params.validationId,
  });
  const actualSalt = keccak256(`${initData}${salt.slice(2)}`);
  const initCodeHash = keccak256(
    `0x${PROXY_PREFIX}${implementation.slice(2).toLowerCase()}${PROXY_SUFFIX}`,
  );
  const digest = keccak256(
    `0xff${factory.slice(2).toLowerCase()}${actualSalt.slice(2)}${initCodeHash.slice(2)}`,
  );
  return `0x${digest.slice(26)}`.toLowerCase();
}
