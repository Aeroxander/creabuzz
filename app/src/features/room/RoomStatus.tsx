/**
 * What stands where a person's composer would be: the composer itself for someone the server will accept, and for everyone else
 * the plain reason and the one thing that fixes it (Back, or confirming the account). Nothing is hidden behind an account: a
 * visitor reads the whole room.
 */
import { Button } from "../../ui/button";
import { dayText, timeText } from "../money/numbers";
import type { ProjectNumbers } from "../money/numbers";
import { doorShutWords } from "../pot/pot-words";
import { ConfirmAccount } from "./ConfirmAccount";
import type { Standing } from "./room-standing";
import {
  CHECKING,
  COULD_NOT_CHECK,
  leftText,
  linkEnded,
  linkEnding,
  MAY_NOT_WRITE,
  mutedLine,
  NEED_LINK,
  NO_PHONE_ROOMS,
  TRY_AGAIN,
  tookOutLine,
} from "./room-words";

/** Take the person to the Back box at the top of the page: the room is for those who back the project. */
function toBackBox() {
  const amount = document.querySelector<HTMLElement>(
    '[data-testid="backing-amount"]',
  );
  const box = document.querySelector<HTMLElement>(
    '[data-testid="backing-box"]',
  );
  (amount ?? box)?.scrollIntoView?.({ block: "center" });
  amount?.focus({ preventScroll: true });
  if (!amount && !box) window.scrollTo?.({ top: 0 });
}

export function RoomStatus({
  standing,
  numbers,
  now,
  onRetry,
  children,
}: {
  standing: Standing;
  numbers: ProjectNumbers | null;
  now: number;
  /** Reads what the person backs again, offered when it could not be read. */
  onRetry?: () => void;
  /** The composer, drawn when the person may write. */
  children: React.ReactNode;
}) {
  switch (standing.kind) {
    case "checking":
      return (
        <p className="text-sm text-muted" data-testid="room-checking">
          {CHECKING}
        </p>
      );
    case "signed-out":
    case "not-holding": {
      const shut = numbers ? doorShutWords(numbers, now) : null;
      return (
        <div className="flex flex-col gap-2" data-testid="room-read-only">
          <p className="text-sm">{MAY_NOT_WRITE}</p>
          {numbers && !shut ? (
            <div>
              <Button
                data-testid="room-back"
                onClick={toBackBox}
                size="sm"
                variant="secondary"
              >
                Back this project
              </Button>
            </div>
          ) : null}
          {shut ? <p className="text-sm text-muted">{shut}</p> : null}
        </div>
      );
    }
    case "could-not-check":
      return (
        <div className="flex flex-col gap-2" data-testid="room-could-not-check">
          <p className="text-sm" role="status">
            {COULD_NOT_CHECK}
          </p>
          {onRetry ? (
            <div>
              <Button
                data-testid="room-retry"
                onClick={onRetry}
                size="sm"
                variant="secondary"
              >
                {TRY_AGAIN}
              </Button>
            </div>
          ) : null}
        </div>
      );
    case "phone-unsupported":
      return (
        <p className="text-sm" data-testid="room-phone-off">
          {NO_PHONE_ROOMS}
        </p>
      );
    case "needs-link":
      return (
        <div className="flex flex-col gap-2" data-testid="room-needs-link">
          <p className="text-sm">{standing.expired ? linkEnded : NEED_LINK}</p>
          <ConfirmAccount />
        </div>
      );
    case "muted":
      return (
        <p className="text-sm" data-testid="room-muted">
          {mutedLine(dayText(standing.until))}
        </p>
      );
    case "write": {
      const unit = numbers?.unit ?? 0;
      return (
        <div className="flex flex-col gap-3">
          {standing.graceEndsAt !== null ? (
            <p className="text-sm" data-testid="room-grace">
              {tookOutLine(
                timeText(standing.graceEndsAt - unit),
                leftText(standing.graceEndsAt - now),
              )}
            </p>
          ) : null}
          {standing.renewBy !== null ? (
            <div className="flex flex-col gap-2" data-testid="room-renew">
              <p className="text-sm">{linkEnding(dayText(standing.renewBy))}</p>
              <ConfirmAccount />
            </div>
          ) : null}
          {children}
        </div>
      );
    }
  }
}
