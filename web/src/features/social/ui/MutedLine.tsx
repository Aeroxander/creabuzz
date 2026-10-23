/**
 * Where something from a person the reader muted would be: one quiet line, with a way to look anyway. Used where hiding
 * the item outright would break what is around it (a reply others answered, a message in a conversation).
 */

export function MutedLine({
  what,
  onShow,
}: {
  /** What is folded away, as a noun phrase: "A reply", "A message". */
  what: string;
  onShow: () => void;
}) {
  return (
    <p className="py-1 text-xs text-muted-foreground" data-testid="muted-line">
      {what} from someone you muted.{" "}
      <button className="underline" onClick={onShow} type="button">
        Show
      </button>
    </p>
  );
}
