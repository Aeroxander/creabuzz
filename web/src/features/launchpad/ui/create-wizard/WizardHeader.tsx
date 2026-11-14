import { UnauditedNotice } from "../UnauditedNotice";

/** The create dialog's title, the line that says what is about to happen, and its notices. */
export function WizardHeader({
  isEdit,
  quick,
  relaunchNote,
}: {
  isEdit: boolean;
  /** The quick setup is showing: its own copy explains itself. */
  quick: boolean;
  /** Why this republishes an old launch, when it does. */
  relaunchNote?: string;
}) {
  return (
    <>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        {isEdit ? "Edit terms" : "Set up a sale"}
      </h2>
      {isEdit || quick ? null : (
        <p className="mt-0.5 text-sm text-black/60 dark:text-white/60">
          Four short steps. Nothing is published until the last one.
        </p>
      )}
      <UnauditedNotice />
      {relaunchNote ? (
        <p
          className="mt-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200"
          data-testid="launch-relaunch-note"
        >
          {relaunchNote}
        </p>
      ) : null}
    </>
  );
}
