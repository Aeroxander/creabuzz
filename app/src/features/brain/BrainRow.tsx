import { useState } from "react";
import { useRequireAccount } from "../../lib/use-require-account";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import type { Project } from "../project/project-record";
import { BrainReader } from "./BrainReader";
import { BrainSetup } from "./BrainSetup";
import { BRAIN_WORDS } from "./brain-copy";
import { useBrainRepo } from "./use-brain";

/**
 * The project's brain on its page, one quiet card:
 * - when the project has a brain repository, "Read the project's notes" opens them (nothing is fetched before that);
 * - when it has none, only its founder sees a line about keeping one, with how.
 * Everyone else sees nothing, and nothing at all while the server has not answered.
 */
export default function BrainRow({
  project,
  isFounder,
  setupOpen = false,
}: {
  project: Project;
  isFounder: boolean;
  /** Open the set-up steps on arrival (a founder who just accepted the offer in Start). */
  setupOpen?: boolean;
}) {
  const repo = useBrainRepo(project);
  const requireAccount = useRequireAccount();
  const [reading, setReading] = useState(false);
  const [setting, setSetting] = useState(setupOpen);
  if (!repo.isSuccess) return null;
  if (repo.data === null && !isFounder) return null;
  return (
    <Card data-testid="brain-row" tone="plain">
      <div className="flex flex-col gap-2">
        <h2 className="text-base font-semibold text-ink">
          {repo.data ? BRAIN_WORDS.name : BRAIN_WORDS.setUpRow}
        </h2>
        <p className="text-sm text-muted">
          {repo.data ? BRAIN_WORDS.readLead : BRAIN_WORDS.setUpLead}
        </p>
        {repo.data && !repo.data.bound && isFounder ? (
          <p className="text-sm text-ink" data-testid="brain-unbound">
            {BRAIN_WORDS.unbound}
          </p>
        ) : null}
        {repo.data ? (
          <>
            <Button
              data-testid="brain-open"
              onClick={() => requireAccount(() => setReading(true))}
              size="sm"
              variant="secondary"
            >
              {BRAIN_WORDS.read}
            </Button>
            <BrainReader
              onOpenChange={setReading}
              open={reading}
              repo={repo.data}
            />
          </>
        ) : (
          <>
            <Button
              data-testid="brain-setup-open"
              onClick={() => setSetting(true)}
              size="sm"
              variant="secondary"
            >
              {BRAIN_WORDS.setUpOpen}
            </Button>
            <BrainSetup
              onOpenChange={setSetting}
              open={setting}
              projectId={project.id}
            />
          </>
        )}
      </div>
    </Card>
  );
}
