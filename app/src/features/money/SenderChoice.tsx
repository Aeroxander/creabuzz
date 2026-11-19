import { useId } from "react";
import { Card } from "../../ui/card";
import { investingOn } from "../../lib/server";
import {
  passkeyUnavailableSentence,
  useSenders,
  writeSenderChoice,
} from "./sender";
import { useWalletAddress } from "./use-money";
import { senderAvailability, type SenderKind } from "./wallet";

/**
 * What a person who can back from more than one place needs to know, on You, and nothing when there is only one:
 * - a browser with a wallet and a passkey account that can send: the choice between them;
 * - no wallet and the passkey account in use: whose account it is and that the passkey is its only key;
 * - no wallet and the passkey account cannot send yet: why, and the other way.
 * Shown only when the build turned passkey sending on, so a build without it looks exactly as it did.
 */
export function SenderChoice() {
  const { wallet, passkey, chosen } = useSenders();
  const legend = useId();
  const address = useWalletAddress();
  if (!investingOn() || !passkey) return null;

  const walletHere = wallet.isAvailable();
  const passkeyOk = senderAvailability(passkey).ok;

  if (walletHere && passkeyOk) {
    const options: { value: SenderKind; label: string; hint: string }[] = [
      {
        value: "wallet",
        label: "The wallet in this browser",
        hint: "You approve each step in your wallet and it takes its own fee.",
      },
      {
        value: "passkey",
        label: "My passkey account",
        hint: "You approve with your passkey and the server pays the fee.",
      },
    ];
    return (
      <Card data-testid="sender-choice">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-semibold" id={legend}>
            Back from
          </legend>
          {options.map((option) => (
            <label
              className="flex min-h-11 cursor-pointer items-start gap-3 text-sm"
              key={option.value}
            >
              <input
                checked={chosen.kind === option.value}
                className="mt-1 size-5 accent-current"
                data-testid={`sender-${option.value}`}
                name="sender"
                onChange={() => writeSenderChoice(option.value)}
                type="radio"
                value={option.value}
              />
              <span>
                <span className="block font-semibold">{option.label}</span>
                <span className="block text-muted">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {chosen.kind === "passkey" ? (
          <PasskeyWords address={address.data} />
        ) : null}
      </Card>
    );
  }

  if (!walletHere && passkeyOk)
    return (
      <Card data-testid="sender-choice">
        <PasskeyWords address={address.data} />
      </Card>
    );

  const sentence = walletHere ? null : passkeyUnavailableSentence(passkey);
  return sentence ? (
    <Card data-testid="sender-choice">
      <p className="text-sm text-muted" data-testid="sender-not-ready">
        {sentence}
      </p>
    </Card>
  ) : null;
}

function PasskeyWords({ address }: { address: string | null | undefined }) {
  return (
    <div
      className="mt-3 flex flex-col gap-2 text-sm"
      data-testid="sender-passkey-words"
    >
      <p>
        You back from your passkey account. The server pays the network fee.
        Your passkey is the only key to the money in this account: if you lose
        it, that money cannot be got back.
      </p>
      {address ? (
        <p className="text-muted">
          Your account address:{" "}
          <span className="num break-all" data-testid="sender-address">
            {address}
          </span>
        </p>
      ) : null}
    </div>
  );
}
