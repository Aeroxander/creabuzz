import {
  PANEL_OPEN_YEARS,
  panelSpare,
  type PanelDraft,
} from "../lib/launch-panel";
import {
  PeoplePicker,
  SelectField,
  TextAreaField,
  TextField,
} from "./decision-fields";

/**
 * Who judges the team's milestones, named in the launch itself. Backers see this before they buy, and no later vote
 * can swap the reviewers for friendlier ones: it is the one decision the team cannot revisit.
 */
export function LaunchPanelFields({
  draft,
  onChange,
  currencySymbol,
  problem,
}: {
  draft: PanelDraft;
  onChange: (next: PanelDraft) => void;
  /** The sale currency's name, which a bond is paid in unless another token is named. */
  currencySymbol: string;
  /** What is wrong with the panel so far, once the founder has started filling it in. */
  problem: string | null;
}) {
  const patch = (next: Partial<PanelDraft>) => onChange({ ...draft, ...next });
  const spare = panelSpare(draft);
  return (
    <div
      className="mt-3 grid gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid="launch-panel-fields"
    >
      <div>
        <h4 className="text-sm font-semibold">Who judges your milestones</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Your team's Shares are held back until reviewers agree a milestone was
          reached. Name them now: backers see them before they buy, and nobody
          can swap them for friendlier ones later, not even a vote. Choose
          people outside your team.
        </p>
      </div>
      <TextAreaField
        after={
          <PeoplePicker
            onPick={(address) =>
              patch({
                reviewers: draft.reviewers
                  .toLowerCase()
                  .includes(address.toLowerCase())
                  ? draft.reviewers
                  : draft.reviewers.trim()
                    ? `${draft.reviewers.trimEnd()}\n${address}`
                    : address,
              })
            }
            testId="launch-panel-people"
          />
        }
        hint="One wallet address per line."
        label="Reviewers"
        onChange={(reviewers) => patch({ reviewers })}
        placeholder="0x…"
        testId="launch-panel-reviewers"
        value={draft.reviewers}
      />
      <TextField
        hint="Leave empty for a simple majority of the reviewers."
        inputMode="numeric"
        label="How many reviewers must agree on a milestone"
        onChange={(quorum) => patch({ quorum })}
        testId="launch-panel-quorum"
        value={draft.quorum}
      />
      <TextField
        hint="Optional. Each reviewer posts this before judging, and loses it if the DAO finds they approved carelessly. Leave empty for none."
        inputMode="decimal"
        label="Bond each reviewer must post"
        onChange={(bond) => patch({ bond })}
        placeholder="0"
        testId="launch-panel-bond"
        value={draft.bond}
      />
      {draft.bond.trim() ? (
        <>
          <SelectField
            label="Bond paid in"
            onChange={(bondIn) =>
              patch({ bondIn: bondIn as PanelDraft["bondIn"] })
            }
            options={[
              { value: "currency", label: `${currencySymbol} (recommended)` },
              { value: "other", label: "Another token" },
            ]}
            testId="launch-panel-bond-token"
            value={draft.bondIn}
          />
          {draft.bondIn === "other" ? (
            <>
              <TextField
                hint="The address of the token on this network."
                label="Token address"
                onChange={(bondOther) => patch({ bondOther })}
                placeholder="0x…"
                testId="launch-panel-bond-other"
                value={draft.bondOther}
              />
              <p className="text-xs text-amber-700 dark:text-amber-300">
                A bond only deters if it keeps its value and nobody involved can
                freeze or inflate it. Check the token before you launch.
              </p>
            </>
          ) : null}
        </>
      ) : null}
      <p
        className="text-xs text-muted-foreground"
        data-testid="launch-panel-continuity"
      >
        The reviewers are fixed, and the panel stays open for {PANEL_OPEN_YEARS}{" "}
        years. If too few of them can be reached, or the panel runs out, no
        milestone can be approved and the locked Shares stay locked; the only
        thing the DAO can then do with them is give them up and burn them. Ask
        your reviewers first, and name more people than the number who must
        agree.
      </p>
      {spare !== null && spare.spare < 1 ? (
        <p
          className="text-xs text-amber-700 dark:text-amber-300"
          data-testid="launch-panel-no-spare"
          role="status"
        >
          {spare.needed === spare.reviewers
            ? "Every reviewer must agree, so one who cannot be reached stops every milestone."
            : "Too few reviewers are named for that many to agree."}{" "}
          Name at least one more.
        </p>
      ) : null}
      {problem ? (
        <p
          className="text-xs text-destructive"
          data-testid="launch-panel-problem"
          role="status"
        >
          {problem}
        </p>
      ) : null}
    </div>
  );
}
