import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from "@noble/hashes/utils.js";
import type { Page } from "@playwright/test";

/**
 * A browser wallet for tests that holds a REAL private key: it signs messages, typed data and transactions itself, the
 * way a person's wallet does, instead of asking Anvil to sign as one of its unlocked dev accounts. So a link between a
 * person's Nostr key and this wallet is a genuine two-signature proof, and a person is a person (a fresh key, funded
 * from the chain's faucet), not one of ten well-known accounts.
 *
 * `installKeyWallet` puts `window.ethereum` on a page. The signing runs in the test process, so no key ever enters the
 * page. Anything that is not a signing request goes to the node.
 *
 * Alias-free and free of browser globals except in `installKeyWallet`, so `key-wallet.test.mjs` drives it under
 * `node --test`.
 */

type Hex = `0x${string}`;
const hex = (bytes: Uint8Array): Hex => `0x${bytesToHex(bytes)}`;

// ------------------------------------------------------------------ keys ---

export interface KeyWallet {
  /** The 32-byte private key. Test only. */
  privateKey: Uint8Array;
  /** Lowercase `0x…` address. */
  address: string;
}

export function addressOf(privateKey: Uint8Array): string {
  const publicKey = secp256k1.getPublicKey(privateKey, false).slice(1);
  return hex(keccak_256(publicKey).slice(-20));
}

/** A fresh wallet nobody has ever held. */
export function newKeyWallet(): KeyWallet {
  const privateKey = randomBytes(32);
  return { privateKey, address: addressOf(privateKey) };
}

export function walletFromKey(privateKeyHex: string): KeyWallet {
  const privateKey = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  return { privateKey, address: addressOf(privateKey) };
}

/** A 65-byte `r ‖ s ‖ v` Ethereum signature over a 32-byte digest, `v` being 27 or 28. */
function signDigest(privateKey: Uint8Array, digest: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, privateKey, {
    prehash: false,
    format: "recovered",
  });
  return concatBytes(recovered.slice(1), new Uint8Array([recovered[0] + 27]));
}

// ------------------------------------------------------------- EIP-191 ---

/** `personal_sign`: the message is bytes when it is `0x` hex, and text otherwise (what wallets do). */
export function personalSign(privateKey: Uint8Array, message: string): Hex {
  const bytes = /^0x([0-9a-f]{2})*$/i.test(message)
    ? hexToBytes(message.slice(2))
    : utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  return hex(signDigest(privateKey, keccak_256(concatBytes(prefix, bytes))));
}

// ------------------------------------------------------------- EIP-712 ---

export interface TypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

const word = (value: bigint): Uint8Array => {
  const unsigned = BigInt.asUintN(256, value);
  return hexToBytes(unsigned.toString(16).padStart(64, "0"));
};

function dependencies(
  type: string,
  types: TypedData["types"],
  found: Set<string> = new Set(),
): Set<string> {
  const base = type.replace(/\[\d*\]$/, "");
  if (found.has(base) || !types[base]) return found;
  found.add(base);
  for (const field of types[base]) dependencies(field.type, types, found);
  return found;
}

export function encodeType(type: string, types: TypedData["types"]): string {
  const others = [...dependencies(type, types)]
    .filter((name) => name !== type)
    .sort();
  return [type, ...others]
    .map(
      (name) =>
        `${name}(${types[name].map((f) => `${f.type} ${f.name}`).join(",")})`,
    )
    .join("");
}

function encodeValue(
  type: string,
  value: unknown,
  types: TypedData["types"],
): Uint8Array {
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array) {
    const items = value as unknown[];
    return keccak_256(
      concatBytes(...items.map((item) => encodeValue(array[1], item, types))),
    );
  }
  if (types[type])
    return hashStruct(type, value as Record<string, unknown>, types);
  if (type === "string") return keccak_256(utf8ToBytes(String(value)));
  if (type === "bytes")
    return keccak_256(hexToBytes(String(value).replace(/^0x/, "")));
  if (type === "bool") return word(value ? 1n : 0n);
  if (type === "address") {
    return word(BigInt(String(value).toLowerCase()));
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    const bytes = hexToBytes(String(value).replace(/^0x/, ""));
    const out = new Uint8Array(32);
    out.set(bytes);
    return out;
  }
  if (/^u?int\d*$/.test(type))
    return word(BigInt(value as string | number | bigint));
  throw new Error(`key-wallet: cannot encode typed-data type ${type}`);
}

export function hashStruct(
  type: string,
  data: Record<string, unknown>,
  types: TypedData["types"],
): Uint8Array {
  const parts = [keccak_256(utf8ToBytes(encodeType(type, types)))];
  for (const field of types[type]) {
    parts.push(encodeValue(field.type, data[field.name], types));
  }
  return keccak_256(concatBytes(...parts));
}

/** The EIP-712 digest a wallet signs for `eth_signTypedData_v4`. */
export function typedDataDigest(typed: TypedData): Uint8Array {
  return keccak_256(
    concatBytes(
      new Uint8Array([0x19, 0x01]),
      hashStruct("EIP712Domain", typed.domain, typed.types),
      hashStruct(typed.primaryType, typed.message, typed.types),
    ),
  );
}

export function signTypedData(privateKey: Uint8Array, typed: TypedData): Hex {
  return hex(signDigest(privateKey, typedDataDigest(typed)));
}

// ------------------------------------------------------- transactions ---

type RlpItem = Uint8Array | RlpItem[];

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return new Uint8Array([offset + length]);
  const size = quantity(BigInt(length));
  return concatBytes(new Uint8Array([offset + 55 + size.length]), size);
}

export function rlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concatBytes(lengthPrefix(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlp));
  return concatBytes(lengthPrefix(body.length, 0xc0), body);
}

/** An integer as RLP wants it: big-endian, no leading zeros, and nothing at all for zero. */
function quantity(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  const digits = value.toString(16);
  return hexToBytes(digits.length % 2 ? `0${digits}` : digits);
}

export interface Eip1559Transaction {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** `null` for a contract creation. */
  to: string | null;
  value: bigint;
  data: string;
}

/** A signed EIP-1559 transaction, ready for `eth_sendRawTransaction`. */
export function signTransaction(
  privateKey: Uint8Array,
  tx: Eip1559Transaction,
): Hex {
  const fields: RlpItem[] = [
    quantity(tx.chainId),
    quantity(tx.nonce),
    quantity(tx.maxPriorityFeePerGas),
    quantity(tx.maxFeePerGas),
    quantity(tx.gasLimit),
    tx.to ? hexToBytes(tx.to.replace(/^0x/, "")) : new Uint8Array(),
    quantity(tx.value),
    hexToBytes(tx.data.replace(/^0x/, "")),
    [],
  ];
  const digest = keccak_256(concatBytes(new Uint8Array([0x02]), rlp(fields)));
  const signature = signDigest(privateKey, digest);
  const signed = [
    ...fields,
    quantity(BigInt(signature[64] - 27)),
    stripZeros(signature.slice(0, 32)),
    stripZeros(signature.slice(32, 64)),
  ];
  return hex(concatBytes(new Uint8Array([0x02]), rlp(signed)));
}

function stripZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  return bytes.slice(start);
}

// ------------------------------------------------------------- the wallet ---

async function call(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (body.error) {
    throw Object.assign(new Error(body.error.message ?? "rpc error"), {
      code: body.error.code,
    });
  }
  return body.result;
}

const big = (value: unknown): bigint => BigInt(String(value));

/**
 * What a wallet answers. Signing is done here; everything else goes to the node. Sends from one wallet are queued so
 * two in flight cannot take the same nonce.
 */
export function createKeyWalletProvider(
  wallet: KeyWallet,
  options: { rpcUrl: string; display?: string },
) {
  let queue: Promise<unknown> = Promise.resolve();
  const shown = options.display ?? wallet.address;
  const isAddress = (value: unknown) =>
    typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

  async function send(tx: Record<string, string | undefined>): Promise<string> {
    const chainId = big(await call(options.rpcUrl, "eth_chainId"));
    const nonce = big(
      await call(options.rpcUrl, "eth_getTransactionCount", [
        wallet.address,
        "pending",
      ]),
    );
    const block = (await call(options.rpcUrl, "eth_getBlockByNumber", [
      "latest",
      false,
    ])) as {
      baseFeePerGas?: string;
    };
    const tip = tx.maxPriorityFeePerGas
      ? big(tx.maxPriorityFeePerGas)
      : 1_000_000_000n;
    const maxFee = tx.maxFeePerGas
      ? big(tx.maxFeePerGas)
      : big(block.baseFeePerGas ?? "0x3b9aca00") * 2n + tip;
    const estimate = tx.gas
      ? big(tx.gas)
      : (big(
          await call(options.rpcUrl, "eth_estimateGas", [
            { from: wallet.address, to: tx.to, data: tx.data, value: tx.value },
          ]),
        ) *
          12n) /
        10n;
    const raw = signTransaction(wallet.privateKey, {
      chainId,
      nonce,
      maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFee,
      gasLimit: estimate,
      to: tx.to ?? null,
      value: tx.value ? big(tx.value) : 0n,
      data: tx.data ?? "0x",
    });
    return String(await call(options.rpcUrl, "eth_sendRawTransaction", [raw]));
  }

  return {
    async request({
      method,
      params = [],
    }: {
      method: string;
      params?: unknown[];
    }): Promise<unknown> {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [shown];
        case "personal_sign": {
          const [first, second] = params as string[];
          return personalSign(
            wallet.privateKey,
            isAddress(first) && !isAddress(second) ? second : first,
          );
        }
        case "eth_signTypedData_v4": {
          const raw = (params as unknown[])[1];
          const typed = (
            typeof raw === "string" ? JSON.parse(raw) : raw
          ) as TypedData;
          return signTypedData(wallet.privateKey, typed);
        }
        case "eth_sendTransaction": {
          const tx = (params as Record<string, string | undefined>[])[0];
          const result = queue.then(() => send(tx));
          queue = result.catch(() => undefined);
          return result;
        }
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        default:
          return call(options.rpcUrl, method, params);
      }
    },
  };
}

/**
 * Put this wallet on `window.ethereum` for every page load. The key stays in the test process: the page asks it to sign.
 * `display` is how the address is spelled to the app (checksummed, as a real wallet does).
 */
export async function installKeyWallet(
  page: Page,
  wallet: KeyWallet,
  options: { rpcUrl: string; display?: string },
): Promise<void> {
  const provider = createKeyWalletProvider(wallet, options);
  await page.exposeFunction(
    "__keyWalletRequest",
    async (method: string, params: unknown[]) => {
      try {
        return { ok: true, result: await provider.request({ method, params }) };
      } catch (error) {
        const e = error as { code?: number; message?: string };
        return {
          ok: false,
          error: {
            code: e.code ?? -32000,
            message: e.message ?? "wallet error",
          },
        };
      }
    },
  );
  await page.addInitScript(() => {
    const ask = (
      window as unknown as {
        __keyWalletRequest: (
          m: string,
          p: unknown[],
        ) => Promise<{
          ok: boolean;
          result?: unknown;
          error?: { code: number; message: string };
        }>;
      }
    ).__keyWalletRequest;
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        request: async ({
          method,
          params,
        }: {
          method: string;
          params?: unknown[];
        }) => {
          const answer = await ask(method, params ?? []);
          if (!answer.ok) throw answer.error;
          return answer.result;
        },
        on() {},
        removeListener() {},
      },
    });
  });
}
