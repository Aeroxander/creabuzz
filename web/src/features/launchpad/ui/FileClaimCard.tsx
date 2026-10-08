import { useState } from "react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Input } from "@/shared/ui/input";
import {
  encodeSetCheck,
  encodeSubmitRecognitionClaim,
  hashText,
  idWord,
  ZERO_WORD,
} from "../lib/work";
import type { MandateView } from "../lib/work-read";

const sameAddress = (a: string | null, b: string) =>
  a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Ask to be recognised for work: name the claim, say where the work is, and state how it should be judged. Two steps
 * go to the wallet (file the claim, then state its check), and the second is retried alone if it fails: the claim
 * already exists by then, and pressing the button again only finishes it.
 *
 * Only claims that ask for no money are filed here: a claim with a payment or a stake needs a currency approval, which
 * stays a command-line step.
 */
export function FileClaimCard({
  mandates,
  wallet,
  gate,
  busy,
  onSend,
}: {
  mandates: MandateView[];
  wallet: string | null;
  gate: string | null;
  busy: string | null;
  /** Sends one transaction; resolves true once it landed. */
  onSend: (key: string, to: string, data: string) => Promise<boolean>;
}) {
  const open = mandates.filter((m) => !m.closed);
  const [which, setWhich] = useState(0);
  const [name, setName] = useState("");
  const [evidence, setEvidence] = useState("");
  const [check, setCheck] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const mandate = open[Math.min(which, open.length - 1)];
  if (!mandate) return null;

  const submit = async () => {
    setProblem(null);
    setFiled(null);
    if (!wallet) {
      setProblem("Connect your wallet to file a claim.");
      return;
    }
    let id: string;
    try {
      id = idWord(name);
    } catch {
      setProblem("Give the claim a short name of 1 to 32 characters.");
      return;
    }
    if (evidence.trim() === "" || check.trim() === "") {
      setProblem("Say where the work is, and how it should be judged.");
      return;
    }
    const existing = mandate.claims.find((c) => c.id === id);
    if (existing && !sameAddress(wallet, existing.record.contributor)) {
      setProblem("Someone else already used that name. Choose another.");
      return;
    }
    if (!existing) {
      const landed = await onSend(
        `file-${id}`,
        mandate.claimsAddress,
        encodeSubmitRecognitionClaim(id, hashText(evidence)),
      );
      if (!landed) return;
    }
    if (!existing || existing.record.checkHash === ZERO_WORD) {
      const landed = await onSend(
        `check-${id}`,
        mandate.claimsAddress,
        encodeSetCheck(id, hashText(check)),
      );
      if (!landed) return;
    }
    setFiled(name.trim());
    setName("");
    setEvidence("");
    setCheck("");
  };

  return (
    <Card className="p-4" data-testid="work-file-claim">
      <h3 className="text-sm font-semibold">
        Ask to be recognised for your work
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        File a claim for what you did. A project manager takes it on, reviewers
        check it, and the DAO can then vote to award you Shares. Nothing is paid
        and nothing is staked.
      </p>
      {open.length > 1 ? (
        <label className="mt-2 flex flex-col gap-1 text-sm">
          <span className="font-medium">Work budget</span>
          <select
            className="rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10"
            onChange={(e) => setWhich(Number(e.target.value))}
            value={which}
          >
            {open.map((m, i) => (
              <option key={m.address} value={i}>
                {m.address.slice(0, 10)}…
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="mt-2 grid gap-2">
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-name-input">
            Name this claim
          </label>
          <Input
            data-testid="work-claim-name"
            id="work-claim-name-input"
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            placeholder="write-the-docs"
            value={name}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-evidence-input">
            Where the work is
          </label>
          <Input
            data-testid="work-claim-evidence"
            id="work-claim-evidence-input"
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="A link, or a short description"
            value={evidence}
          />
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="font-medium" htmlFor="work-claim-check-input">
            How it should be judged
          </label>
          <Input
            data-testid="work-claim-check"
            id="work-claim-check-input"
            onChange={(e) => setCheck(e.target.value)}
            placeholder="The project's acceptance check, in its exact words"
            value={check}
          />
          <span className="text-xs text-muted-foreground">
            Use the words the project uses. If they differ, its manager cannot
            take your claim on.
          </span>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          data-testid="work-claim-submit"
          disabled={busy !== null || gate !== null}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          File claim
        </Button>
        {filed ? (
          <span
            className="text-sm"
            data-testid="work-claim-filed"
            role="status"
          >
            Filed “{filed}”. It is waiting for a project manager.
          </span>
        ) : null}
      </div>
      {problem ? (
        <p
          className="mt-2 text-sm text-red-700 dark:text-red-300"
          data-testid="work-claim-problem"
          role="alert"
        >
          {problem}
        </p>
      ) : null}
    </Card>
  );
}
