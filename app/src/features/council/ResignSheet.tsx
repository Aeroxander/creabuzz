/**
 * Give up your own seat on the Council (the contract's `resign`, sent from the seat's own account, never a proposal):
 * what it does is said first — the seat comes up at the next vote, and every call waiting for the seats' agreement stops
 * — then one press. The words are `council/council-words`'s, so no sentence is typed here.
 */
import { resignCall } from "@creaton/core/pot/pot-calls.ts";
import { decodeReturn, encodeCall } from "@creaton/core/pot/abi-codec.ts";
import { COUNCIL_ABI } from "@creaton/core/pot/abis.generated.ts";
import type { ProjectNumbers } from "../money/numbers";
import { PotSheet } from "../pot/PotSheet";
import type { Ready } from "../pot/use-pot";
import { GIVE_UP_SEAT, resignWords } from "./council-words";
import type { CouncilNumbers } from "../money/numbers-types";

const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

export function ResignSheet({
  numbers,
  ready,
  council,
  seatIndex,
  open,
  onClose,
}: {
  numbers: ProjectNumbers;
  ready: Ready;
  council: CouncilNumbers;
  /** Which of the five seats this account holds. */
  seatIndex: number;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <PotSheet
      account={ready.address}
      action={`seat-resign:${numbers.chainId}:${council.contract}`}
      calls={[resignCall(council.contract)]}
      chainId={numbers.chainId}
      confirmLabel={GIVE_UP_SEAT}
      description="Give up the seat that runs the project's money"
      done="You gave up your seat."
      landed={async (wallet) => {
        // The seat this account held is open again: the network's own answer, never the page's memory of it.
        const answer = await wallet.readCall(
          council.contract,
          encodeCall(COUNCIL_ABI, "seatOf", [BigInt(seatIndex)]),
        );
        const [who] = decodeReturn(COUNCIL_ABI, "seatOf", answer);
        return typeof who === "string" && who.toLowerCase() === ZERO_ADDRESS;
      }}
      lookLabel="Look for your seat"
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      open={open}
      playMoney={numbers.playMoney}
      problemAction="seat"
      testId="resign-sheet"
      title="Give up your seat?"
    >
      <ul
        className="flex list-disc flex-col gap-1.5 pl-5 text-sm"
        data-testid="resign-terms"
      >
        {resignWords(council.needed, council.seats.length).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </PotSheet>
  );
}
