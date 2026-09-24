/**
 * ZeroDev Kernel wiring: install packages, counterfactual initcode, and the
 * Kernel nonce layout — all against the REAL vendored sources (no invented
 * ABIs):
 *
 * - Kernel core + factory (cloned from https://github.com/zerodevapp/kernel,
 *   the current home of the Kernel contracts; vendored this wave at
 *   `contracts/lib/zerodev-kernel`):
 *   - `src/KernelFactory.sol` — `deploy(Install[] initialPackages, uint256
 *     nonce)`, `getAddress(...)`, and the CREATE2 salt derivation
 *     (`_calculateSalt`). initCode = `factory ‖ abi.encodeCall(deploy, …)`;
 *     the account is a deterministic ERC-1967 clone (solady LibClone) whose
 *     address is queried through `getAddress` / `EntryPoint.getSenderAddress`
 *     (see `getSenderAddress` in `aa.ts`) — off-chain CREATE2 re-derivation
 *     would require replicating solady's ERC-1967 clone bytecode and is
 *     deliberately NOT attempted here (TODO(wave4c) if RPC-less derivation is
 *     ever needed).
 *   - `src/types/Structs.sol` — `Install { uint256 moduleType; address
 *     module; bytes moduleData; bytes internalData; }`.
 *   - `src/types/Constants.sol` — `MODULE_TYPE_VALIDATOR = 1`,
 *     `HOOK_MODULE_NOT_INSTALLED = address(0)`,
 *     `HOOK_MODULE_INSTALLED_NO_HOOK = address(1)`.
 *   - `src/core/ValidationManager.sol` `_initializeValidation` — validator
 *     `internalData` = `bytes20 hook ‖ packed bytes4 selectors`; empty means
 *     "installed, no hook, no selectors" (fine for the root passkey
 *     validator).
 *   - `src/lib/Utils.sol` `parseNonce` — nonce layout `[1 byte vMode | 1 byte
 *     vType | 20 bytes vId | 2 bytes nonceKey | 8 bytes sequence]`; the fresh
 *     root validator's first UserOp is nonce 0 (vMode 0 = standard, vType 0 =
 *     ROOT → routes to the first installed validator).
 *   - `src/Kernel.sol:218` `execute(bytes32 mode, bytes executionData)` and
 *     solady `LibERC7579.decodeSingle` (vendored `dependencies/solady-0.1.26`)
 *     — `executionData = address20 ‖ uint256 value ‖ raw data`, mode byte 0 =
 *     CALLTYPE_SINGLE, mode byte 1 = EXECTYPE_DEFAULT (all-zero mode is
 *     "single call, revert on failure").
 * - WebAuthnValidator (vendored at `contracts/lib/zerodev-kernel-7579-plugins`,
 *   from https://github.com/zerodevapp/kernel-7579-plugins):
 *   - `src/validators/WebAuthnValidator.sol` `onInstall` —
 *     `abi.decode(data, (WebAuthnValidatorData, bytes32))` with
 *     `WebAuthnValidatorData { uint256 pubKeyX; uint256 pubKeyY; }`.
 */
import type { AbiField } from "./userop-abi.ts";
import { abiEncode, abiEncodeCall, decodeAddressWord } from "./userop-abi.ts";
import type { EthCall } from "./aa.ts";

/** `KernelFactory.deploy((uint256,address,bytes,bytes)[],uint256)` (cast-checked). */
export const KERNEL_DEPLOY_SIGNATURE =
  "deploy((uint256,address,bytes,bytes)[],uint256)";

/** `KernelFactory.getAddress((uint256,address,bytes,bytes)[],uint256)` (cast-checked). */
export const KERNEL_GET_ADDRESS_SIGNATURE =
  "getAddress((uint256,address,bytes,bytes)[],uint256)";

/** `Kernel.execute(bytes32,bytes)` (cast-checked). */
export const KERNEL_EXECUTE_SIGNATURE = "execute(bytes32,bytes)";

/** `Constants.sol`: moduleType 1 = validator. */
export const KERNEL_MODULE_TYPE_VALIDATOR = 1n;

/** One `Install` package (`src/types/Structs.sol`). */
export interface KernelInstall {
  moduleType: bigint;
  module: string;
  moduleData: string;
  internalData: string;
}

const installFields = (install: KernelInstall): AbiField[] => [
  { kind: "uint", value: install.moduleType },
  { kind: "address", value: install.module },
  { kind: "bytes", value: install.moduleData },
  { kind: "bytes", value: install.internalData },
];

/**
 * `WebAuthnValidator.onInstall` data:
 * `abi.encode(WebAuthnValidatorData { pubKeyX, pubKeyY }, bytes32(0))`
 * (the trailing word is decoded and ignored by the validator).
 */
export function webAuthnValidatorModuleData(
  pubKeyX: bigint,
  pubKeyY: bigint,
): string {
  return abiEncode([
    {
      kind: "tuple",
      fields: [
        { kind: "uint", value: pubKeyX },
        { kind: "uint", value: pubKeyY },
      ],
    },
    { kind: "bytes32", value: `0x${"00".repeat(32)}` },
  ]);
}

/**
 * Validator `internalData` per `ValidationManager._initializeValidation`:
 * `bytes20 hook ‖ packed bytes4[] allowedSelectors`. An omitted hook is
 * encoded as `address(0)`; with no hook AND no selectors the empty string is
 * the documented "installed, no hook, no selectors" form.
 */
export function validatorInternalData(options: {
  hook?: string;
  allowedSelectors?: string[];
}): string {
  const selectors = options.allowedSelectors ?? [];
  if (options.hook === undefined && selectors.length === 0) {
    return "0x";
  }
  const hook = options.hook ?? `0x${"00".repeat(20)}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(hook)) {
    throw new Error(`aa-kernel: hook must be a 20-byte address, got ${hook}`);
  }
  let out = hook;
  for (const selector of selectors) {
    if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) {
      throw new Error(`aa-kernel: selector must be 4 bytes, got ${selector}`);
    }
    out += selector.slice(2);
  }
  return out.toLowerCase();
}

/** Build the Install package for the Kernel WebAuthnValidator. */
export function webAuthnValidatorInstall(options: {
  validator: string;
  pubKeyX: bigint;
  pubKeyY: bigint;
  hook?: string;
  allowedSelectors?: string[];
}): KernelInstall {
  return {
    moduleType: KERNEL_MODULE_TYPE_VALIDATOR,
    module: options.validator,
    moduleData: webAuthnValidatorModuleData(options.pubKeyX, options.pubKeyY),
    internalData: validatorInternalData({
      hook: options.hook,
      allowedSelectors: options.allowedSelectors,
    }),
  };
}

/**
 * Counterfactual initCode: the 20-byte factory address followed by the
 * `KernelFactory.deploy(initialPackages, deployNonce)` call — the exact
 * prefix/args `SenderCreator` executes to create the account.
 */
export function buildKernelInitCode(options: {
  factory: string;
  initialPackages: KernelInstall[];
  deployNonce: bigint;
}): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.factory)) {
    throw new Error(
      `aa-kernel: factory must be a 20-byte address, got ${options.factory}`,
    );
  }
  if (options.initialPackages.length === 0) {
    throw new Error("aa-kernel: initialPackages must not be empty");
  }
  const call = abiEncodeCall(KERNEL_DEPLOY_SIGNATURE, [
    { kind: "tuple[]", items: options.initialPackages.map(installFields) },
    { kind: "uint", value: options.deployNonce },
  ]);
  return `${options.factory}${call.slice(2)}`.toLowerCase();
}

/**
 * Kernel nonce (`src/lib/Utils.sol parseNonce`): `[1 byte vMode | 1 byte
 * vType | 20 bytes vId | 2 bytes nonceKey | 8 bytes sequence]` — the 24-byte
 * key ‖ 8-byte sequence split of the ERC-4337 nonce
 * (`NonceManager.getNonce`: `key = uint192(nonce >> 64)`). Defaults give the
 * standard-mode ROOT validation (nonce `0x0`) whose signature is verified by
 * the root validator (the first installed validator — the WebAuthnValidator
 * for this account).
 */
export function buildKernelNonce(options?: {
  /** 0x00 standard (default), 0x08 enable mode — `Types.sol ValidationMode`. */
  validationMode?: number;
  /** 0x00 ROOT (default) routes to the root validator; 0x01 = installed validator. */
  validationType?: number;
  /** 20-byte validator address (vId); ignored for ROOT. */
  validator?: string;
  /** 2-byte nonce key within the validation. */
  nonceKey?: number;
  /** 8-byte sequence within the validation (the ERC-4337 low 64 bits). */
  sequence?: bigint;
}): string {
  const validationMode = options?.validationMode ?? 0;
  const validationType = options?.validationType ?? 0;
  const nonceKey = options?.nonceKey ?? 0;
  const sequence = options?.sequence ?? 0n;
  if (validationMode < 0 || validationMode > 0xff) {
    throw new Error("aa-kernel: validationMode must be one byte");
  }
  if (validationType < 0 || validationType > 0xff) {
    throw new Error("aa-kernel: validationType must be one byte");
  }
  if (nonceKey < 0 || nonceKey > 0xffff) {
    throw new Error("aa-kernel: nonceKey must be two bytes");
  }
  if (sequence < 0n || sequence > 0xffffffffffffffffn) {
    throw new Error("aa-kernel: sequence must be eight bytes");
  }
  const validator = options?.validator ?? `0x${"00".repeat(20)}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(validator)) {
    throw new Error(
      `aa-kernel: validator must be a 20-byte address, got ${validator}`,
    );
  }
  if (validationType === 0 && validator !== `0x${"00".repeat(20)}`) {
    throw new Error(
      "aa-kernel: ROOT nonce (validationType 0) takes no validator address",
    );
  }
  const hex =
    validationMode.toString(16).padStart(2, "0") +
    validationType.toString(16).padStart(2, "0") +
    validator.slice(2) +
    nonceKey.toString(16).padStart(4, "0") +
    sequence.toString(16).padStart(16, "0");
  return `0x${BigInt(`0x${hex}`).toString(16)}`;
}

/**
 * Query the deterministic account address from the factory itself
 * (`KernelFactory.getAddress`); an alternative to the `getSenderAddress`
 * revert flow for callers that already talk to the factory.
 */
export async function getSenderFromKernelFactory(options: {
  call: EthCall;
  factory: string;
  initialPackages: KernelInstall[];
  deployNonce: bigint;
}): Promise<string> {
  const data = abiEncodeCall(KERNEL_GET_ADDRESS_SIGNATURE, [
    { kind: "tuple[]", items: options.initialPackages.map(installFields) },
    { kind: "uint", value: options.deployNonce },
  ]);
  return decodeAddressWord(await options.call({ to: options.factory, data }));
}

/**
 * Dummy UserOp callData for hash-shape testing: `execute(bytes32(0),
 * ‖ sender ‖ uint256(0) ‖ "")` — the account calls itself with an empty call
 * (lands in `receive()`), a harmless, real Kernel entry point.
 */
export function buildKernelSelfCallData(sender: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(sender)) {
    throw new Error(
      `aa-kernel: sender must be a 20-byte address, got ${sender}`,
    );
  }
  const executionData = `${sender}${"00".repeat(32)}`;
  return abiEncodeCall(KERNEL_EXECUTE_SIGNATURE, [
    { kind: "bytes32", value: `0x${"00".repeat(32)}` },
    { kind: "bytes", value: executionData },
  ]);
}
