/**
 * A wallet in the page for the money screens of the pot contracts: it answers each read by decoding the call with the
 * generated ABIs and looking the function's name up in a table the test holds (the table can change between steps), lists
 * the calls it is asked to send, and can refuse the next send with a contract refusal. It holds no contract logic: a test
 * says what the chain answers, and checks what the screen sent.
 */
import {
  type AbiValue,
  encodeParameters,
  selectorOf,
} from "../../../packages/creaton-core/src/launchpad/evmAbi.ts";
import {
  abiTypeOf,
  decodeCall,
  functionOf,
} from "../../../packages/creaton-core/src/pot/abi-codec.ts";
import {
  EARLIER_GRANTS_ABI,
  HOLDER_PAUSE_ABI,
  LAUNCHER_ABI,
  PAIR_ABI,
  PLAY_DOLLAR_ABI,
  SHARE_TOKEN_ABI,
  TASK_BOOK_ABI,
  TREASURY_ABI,
  VESTER_ABI,
} from "../../../packages/creaton-core/src/pot/abis.generated.ts";

// The Pair and the Launcher go last: a name they share with the Treasury (`checkIn`, `platform`) is the Treasury's.
// The task book follows the Treasury: `noticeFor` and `unit` are the same function on both and read the same.
const ABIS = [
  TREASURY_ABI,
  TASK_BOOK_ABI,
  VESTER_ABI,
  SHARE_TOKEN_ABI,
  PLAY_DOLLAR_ABI,
  PAIR_ABI,
  LAUNCHER_ABI,
  HOLDER_PAUSE_ABI,
  EARLIER_GRANTS_ABI,
];

/** The values a view returns, or a function of the call's arguments and the contract it was sent to. */
type Answer =
  | AbiValue[]
  | ((args: readonly unknown[], to: string) => AbiValue[]);

export interface PotChain {
  /** Every call the wallet was asked to send. */
  sent: { from: string; to: string; data: string }[];
  /** The answers by function name; a test changes them between steps. */
  answers: Record<string, Answer>;
  /** Every read the wallet answered, by function name and arguments. */
  reads: { name: string; args: readonly unknown[] }[];
  /** The account the wallet shows. */
  account: string;
  /** The next send fails with this node message once (a contract refusal read as `execution reverted: Name()`). */
  refuse: string | null;
  /** While true no sent call has a receipt yet (the wallet's wait runs out). */
  holdReceipts: boolean;
  /** What `eth_getLogs` answers. */
  logs: unknown[];
  /** Called after each send lands, to change the answers the way the chain would. */
  onSend: ((tx: { from: string; to: string; data: string }) => void) | null;
  /** The network the wallet is on, as a hex number. */
  chain: string;
  /** The time (unix seconds) of every block it answers about: the chain's own clock, which a test can move. */
  blockTime: number;
}

/** `supportsInterface(bytes4)` answered by hand: the shared encoder has no bytes4. */
const SUPPORTS_INTERFACE = selectorOf("supportsInterface(bytes4)");

export function installPotChain(options: {
  account: string;
  answers: Record<string, Answer>;
  /** Does the dollar have pay-and-call (one signature)? Default yes. */
  payAndCall?: boolean;
  chain?: string;
  logs?: unknown[];
  /** The Launcher's address: reads sent to it use its ABI first (its `platform` has five answers, the Treasury's one). */
  launcher?: string;
}): PotChain {
  const chain: PotChain = {
    sent: [],
    answers: options.answers,
    reads: [],
    account: options.account,
    refuse: null,
    holdReceipts: false,
    logs: options.logs ?? [],
    onSend: null,
    chain: options.chain ?? "0x7a69",
    blockTime: Math.floor(Date.now() / 1000),
  };
  (window as unknown as { ethereum: unknown }).ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === "eth_accounts" || method === "eth_requestAccounts")
        return [chain.account];
      if (method === "eth_chainId") return chain.chain;
      if (method === "wallet_switchEthereumChain") {
        chain.chain = (params?.[0] as { chainId: string }).chainId;
        return null;
      }
      if (method === "eth_blockNumber") return "0x3e8";
      if (method === "eth_getBlockByNumber")
        return { timestamp: `0x${chain.blockTime.toString(16)}` };
      if (method === "eth_getLogs") return chain.logs;
      if (method === "eth_getTransactionCount")
        return `0x${chain.sent.length.toString(16)}`;
      if (method === "eth_getTransactionByHash") return null;
      if (method === "eth_call") {
        const { to, data } = params?.[0] as { to: string; data: string };
        if (chain.chain !== "0x7a69") return "0x";
        if (data.startsWith(SUPPORTS_INTERFACE)) {
          if (options.payAndCall === false)
            return encodeParameters(["bool"], [false]);
          return encodeParameters(["bool"], [true]);
        }
        const order =
          options.launcher && to.toLowerCase() === options.launcher
            ? [LAUNCHER_ABI, ...ABIS]
            : ABIS;
        for (const abi of order) {
          const call = decodeCall(abi, data);
          if (!call) continue;
          chain.reads.push({ name: call.name, args: call.args });
          const answer = chain.answers[call.name];
          if (answer === undefined)
            throw { code: -32603, message: `no answer for ${call.name}` };
          const values =
            typeof answer === "function"
              ? answer(call.args, to.toLowerCase())
              : answer;
          const fn = functionOf(abi, call.name, call.args.length);
          return encodeParameters((fn.outputs ?? []).map(abiTypeOf), values);
        }
        throw { code: -32603, message: "unknown call" };
      }
      if (method === "eth_sendTransaction") {
        if (chain.refuse) {
          const message = chain.refuse;
          chain.refuse = null;
          throw { code: -32603, message };
        }
        const tx = params?.[0] as { to: string; data: string };
        const call = { from: chain.account, to: tx.to, data: tx.data };
        chain.sent.push(call);
        chain.onSend?.(call);
        return `0x${chain.sent.length.toString(16).padStart(64, "0")}`;
      }
      if (method === "eth_getTransactionReceipt")
        return chain.holdReceipts ? null : { status: "0x1" };
      throw { code: 4200, message: method };
    },
  };
  return chain;
}
