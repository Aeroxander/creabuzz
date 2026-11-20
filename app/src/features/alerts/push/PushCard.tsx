/**
 * "Alerts when you are away" on You (plan section 7.8): one question, off by default, what will be sent in one sentence, and
 * how to turn it off. Drawn only where the server turns investing on and says it can send alerts (`webPush` in its information
 * document): the app never invents a way to switch them on. Nothing is asked of the browser until the person presses
 * "Turn on alerts". A person whose account the server cannot tie to a wallet is told what to do, with the same press the room uses.
 */
import {
  serverSmartAccountLinks,
  serverWebPushKey,
} from "@creaton/core/client/server-settings.ts";
import { useId } from "react";
import { investingOn } from "../../../lib/server";
import { Button } from "../../../ui/button";
import { Card } from "../../../ui/card";
import { useWallet } from "../../money/use-money";
import { senderKind } from "../../money/wallet";
import { ConfirmAccount } from "../../room/ConfirmAccount";
import { useTeamWallets } from "../../team/use-wallets";
import {
  PUSH_ASKING,
  PUSH_BLOCKED,
  PUSH_CANNOT,
  PUSH_EXPLAINED,
  PUSH_FAILED,
  PUSH_HEADING,
  PUSH_IS_ON,
  PUSH_NEEDS_LINK,
  PUSH_NO_PHONE,
  PUSH_OFF_DONE,
  PUSH_OFF_FAILED,
  PUSH_OFF_PENDING,
  PUSH_SMALL,
  PUSH_TURN_OFF,
  PUSH_TURN_ON,
} from "./push-words";
import { type PushNote, usePushAlerts } from "./use-push";

const NOTE_WORDS: Record<Exclude<PushNote, null>, string> = {
  "off-done": PUSH_OFF_DONE,
  "off-pending": PUSH_OFF_PENDING,
  "off-failed": PUSH_OFF_FAILED,
  failed: PUSH_FAILED,
};

export function PushCard({ me }: { me: string }) {
  const headingId = useId();
  const wallet = useWallet();
  const linked = useTeamWallets([me]);
  const { view, note, on, off } = usePushAlerts(me);
  if (!investingOn() || !serverWebPushKey()) return null;

  // A phone account the server cannot check, or an account tied to no wallet, cannot be told which projects it backs.
  const phoneNotChecked =
    senderKind(wallet) === "passkey" && serverSmartAccountLinks() === false;
  const state = linked.data?.[me]?.state;
  const needsLink = state === "none" || state === "expired";

  let body: React.ReactNode;
  if (view === "checking" || (view === "off" && linked.isPending))
    body = <div className="h-12 animate-pulse" data-testid="push-checking" />;
  else if (view === "cannot") body = <p className="text-sm">{PUSH_CANNOT}</p>;
  else if (view === "blocked") body = <p className="text-sm">{PUSH_BLOCKED}</p>;
  else if (view === "on")
    body = (
      <>
        <p className="text-sm" data-testid="push-state">
          {PUSH_IS_ON}
        </p>
        <Button onClick={() => void off()} size="sm" variant="secondary">
          {PUSH_TURN_OFF}
        </Button>
      </>
    );
  else if (phoneNotChecked) body = <p className="text-sm">{PUSH_NO_PHONE}</p>;
  else if (needsLink)
    body = (
      <>
        <p className="text-sm" data-testid="push-needs-link">
          {PUSH_NEEDS_LINK}
        </p>
        <ConfirmAccount />
      </>
    );
  else
    body = (
      <>
        <p className="text-sm" data-testid="push-state">
          {PUSH_EXPLAINED}
        </p>
        <Button
          disabled={view === "working"}
          onClick={() => void on()}
          size="sm"
        >
          {view === "working" ? PUSH_ASKING : PUSH_TURN_ON}
        </Button>
      </>
    );

  const problem = note === "failed" || note === "off-failed";
  return (
    <Card
      aria-labelledby={headingId}
      className="flex flex-col gap-2"
      data-testid="push-card"
      role="region"
    >
      <h2 className="font-semibold" id={headingId}>
        {PUSH_HEADING}
      </h2>
      {note ? (
        <p
          className={problem ? "text-sm text-danger" : "text-sm"}
          data-testid="push-note"
          role={problem ? "alert" : "status"}
        >
          {NOTE_WORDS[note]}
        </p>
      ) : null}
      {body}
      {PUSH_SMALL.map((line) => (
        <p className="text-sm text-muted" key={line}>
          {line}
        </p>
      ))}
    </Card>
  );
}
