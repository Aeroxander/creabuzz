/**
 * Encoding and decoding by ABI for the money contracts (`abis.generated.ts`), on top of the small shared encoder in
 * `launchpad/evmAbi.ts` (no contract library). A call is named by its function's name and, when two share a name, by the
 * number of arguments, so a builder never types a signature string and cannot drift from the contract.
 *
 * Pure: bytes in, bytes out. Strict: a value that does not fit its type throws here instead of reaching a wallet.
 */
import {
  type AbiType,
  type AbiValue,
  type DecodedValue,
  decodeParameters,
  encodeParameters,
  selectorOf,
} from "../launchpad/evmAbi.ts";

/** One input or output of an ABI item. */
export interface AbiParam {
  readonly name?: string;
  readonly type: string;
  readonly components?: readonly AbiParam[];
}

/** One entry of a contract ABI (a function, an event, an error, a constructor). */
export interface AbiItem {
  readonly type: string;
  readonly name?: string;
  readonly inputs?: readonly AbiParam[];
  readonly outputs?: readonly AbiParam[];
  readonly stateMutability?: string;
  readonly anonymous?: boolean;
}

/** An ABI as the generated file holds it. */
export type Abi = readonly AbiItem[];

/** The ABI type the shared encoder uses for one parameter (tuples and dynamic arrays included). */
export function abiTypeOf(param: AbiParam): AbiType {
  const array = /^(.*)\[\]$/.exec(param.type);
  if (array) return { array: abiTypeOf({ ...param, type: array[1] ?? "" }) };
  if (param.type === "tuple")
    return { tuple: (param.components ?? []).map(abiTypeOf) };
  if (/^bytes([1-9]|[12]\d|3[01])$/.test(param.type))
    throw new Error(`${param.type} is not supported by the shared encoder`);
  if (/\[\d+\]$/.test(param.type))
    throw new Error(`${param.type} is not supported by the shared encoder`);
  return param.type as AbiType;
}

/** The canonical text of a parameter's type: tuples are spelled out as `(a,b)`. */
function typeText(param: AbiParam): string {
  const array = /^tuple((\[\d*\])*)$/.exec(param.type);
  if (array)
    return `(${(param.components ?? []).map(typeText).join(",")})${array[1] ?? ""}`;
  return param.type;
}

/** `name(type,type)`, the text a selector is the hash of. */
export function signatureOf(item: AbiItem): string {
  return `${item.name ?? ""}(${(item.inputs ?? []).map(typeText).join(",")})`;
}

/** The function `name` of `abi`; when several share the name, the one with `argCount` arguments. */
export function functionOf(abi: Abi, name: string, argCount?: number): AbiItem {
  const found = abi.filter(
    (item) =>
      item.type === "function" &&
      item.name === name &&
      (argCount === undefined || (item.inputs ?? []).length === argCount),
  );
  if (found.length !== 1 || !found[0])
    throw new Error(
      `${found.length === 0 ? "No" : "More than one"} function ${name} with ${argCount ?? "any"} arguments in this ABI`,
    );
  return found[0];
}

/** The calldata of calling function `name` with `args` (selector, then the arguments). */
export function encodeCall(
  abi: Abi,
  name: string,
  args: readonly AbiValue[],
): string {
  const fn = functionOf(abi, name, args.length);
  const types = (fn.inputs ?? []).map(abiTypeOf);
  return selectorOf(signatureOf(fn)) + encodeParameters(types, args).slice(2);
}

/** A call read back out of calldata: which function, and its arguments by position. */
export interface DecodedCall {
  readonly name: string;
  readonly signature: string;
  readonly args: readonly DecodedValue[];
}

/** Which item of `abi` of `kind` starts with `selector`, or null. */
function bySelector(
  abi: Abi,
  kind: "function" | "error",
  selector: string,
): AbiItem | null {
  return (
    abi.find(
      (item) =>
        item.type === kind && selectorOf(signatureOf(item)) === selector,
    ) ?? null
  );
}

/** Read calldata back into the function it calls and its arguments; null when no function of `abi` matches. */
export function decodeCall(abi: Abi, data: string): DecodedCall | null {
  const hex = data.toLowerCase();
  if (!/^0x[0-9a-f]{8}([0-9a-f]{2})*$/.test(hex)) return null;
  const fn = bySelector(abi, "function", hex.slice(0, 10));
  if (!fn?.name) return null;
  const args = decodeParameters(
    (fn.inputs ?? []).map(abiTypeOf),
    `0x${hex.slice(10)}`,
  );
  return { name: fn.name, signature: signatureOf(fn), args };
}

/** What a view returned, by position: `data` is the node's answer to a call of function `name`. */
export function decodeReturn(
  abi: Abi,
  name: string,
  data: string,
  argCount?: number,
): DecodedValue[] {
  const fn = functionOf(abi, name, argCount);
  return decodeParameters((fn.outputs ?? []).map(abiTypeOf), data);
}

/** A custom error read out of a failed call's data. */
export interface DecodedRevert {
  readonly name: string;
  readonly args: readonly DecodedValue[];
}

/** The custom error `data` carries, looked up in each ABI in turn, or null (a plain revert, a panic, no data). */
export function decodeRevert(
  abis: readonly Abi[],
  data: unknown,
): DecodedRevert | null {
  if (typeof data !== "string") return null;
  const hex = data.toLowerCase();
  if (!/^0x[0-9a-f]{8}([0-9a-f]{2})*$/.test(hex)) return null;
  for (const abi of abis) {
    const item = bySelector(abi, "error", hex.slice(0, 10));
    if (!item?.name) continue;
    try {
      const args = decodeParameters(
        (item.inputs ?? []).map(abiTypeOf),
        `0x${hex.slice(10)}`,
      );
      return { name: item.name, args };
    } catch {
      return { name: item.name, args: [] };
    }
  }
  return null;
}

/** Every custom error of `abi`, as `name(type,type)`. */
export function errorSignatures(abi: Abi): string[] {
  return abi.filter((item) => item.type === "error").map(signatureOf);
}
