// A stand-in for a node's `eth_call`: answers each read from a table of function name to values, by decoding the calldata
// with the ABI. Used by the read and plan tests; it holds no contract logic.
import { encodeParameters } from "../launchpad/evmAbi.ts";
import { abiTypeOf, decodeCall, functionOf } from "./abi-codec.ts";
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
} from "./abis.generated.ts";

// The Pair and the Launcher go last: a name they share with the Treasury (`checkIn`, `platform`) is the Treasury's here.
// The task book follows the Treasury: `noticeFor` and `unit` are the same function on both, and read the same.
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

/** `answers[name]` is the values to return, or a function of the decoded args that returns them. */
export function fakeChain(answers) {
  const seen = [];
  const read = async (to, data) => {
    if (data.startsWith("0x01ffc9a7")) {
      // supportsInterface(bytes4): the shared encoder has no bytes4, so it is answered here by hand.
      seen.push({ to, name: "supportsInterface", args: [data.slice(10, 18)] });
      const answer = answers.supportsInterface;
      if (answer === undefined)
        throw new Error("reverted: no answer for supportsInterface");
      return encodeParameters(["bool"], [answer[0]]);
    }
    for (const abi of ABIS) {
      const call = decodeCall(abi, data);
      if (!call) continue;
      seen.push({ to, name: call.name, args: call.args });
      const answer = answers[call.name];
      if (answer === undefined)
        throw new Error(`reverted: no answer for ${call.name}`);
      const values =
        typeof answer === "function" ? answer(...call.args) : answer;
      const fn = functionOf(abi, call.name, call.args.length);
      return encodeParameters(fn.outputs.map(abiTypeOf), values);
    }
    throw new Error("reverted: unknown call");
  };
  return { read, seen };
}
