import { useReducer, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { isEvmAddress, mintCommandForPlan, type Launch } from "../models";
import { ethCall, getRpcEndpoint, isContractDeployed } from "../chain";
import {
  initMintFlow,
  type MintAttemptInput,
  mintFlowReducer,
  MINT_STEPS,
  retryMintAttempt,
  retryPlan,
  runMintAttempt,
} from "../lib/mint-flow";
import { type CreateLaunchInput } from "../use-launches";
import { Input } from "@/shared/ui/input";
import {
  resolveSender,
  SenderPickerControls,
  senderErrorMessage,
  useSenderPicker,
} from "./SenderPicker";

/**
 * One-click "Deploy token": the `DeployAppToken.s.sol` sequence through the
 * sender picker (wallet vs sponsored passkey). The composer
 * (`lib/mint-tx.ts`) is shared and byte-identical across senders; the SEND
 * strategy differs — the sponsored sender batches the 3 calls into ONE UserOp
 * (kernel-0.3.3 CALLTYPE_BATCH, atomic), the injected wallet sends 3
 * sequential transactions (each receipt awaited before the next). Preflight,
 * the CREATE2 code check (idempotent retry), and the record write-back run
 * exactly as desktop `lib/mintFlow.ts` prescribes.
 */
function DeployTokenFlow({
  launch,
  onLink,
}: {
  launch: Launch;
  onLink: (input: CreateLaunchInput) => Promise<void>;
}) {
  const plan = launch.record.tokenPlan;
  const picker = useSenderPicker();
  const [state, dispatch] = useReducer(
    mintFlowReducer,
    undefined,
    initMintFlow,
  );
  const [running, setRunning] = useState(false);
  if (!plan) return null;

  const attemptInput = async (): Promise<MintAttemptInput> => {
    const sender = resolveSender(picker);
    const deployer = await sender.getAddress();
    const toSenderCall = (call: {
      to: string;
      data: string;
      value: string;
    }) => ({ to: call.to, data: call.data, value: call.value });
    return {
      plan: {
        name: plan.name,
        symbol: plan.symbol,
        supply: plan.supply,
        recordTreasury: launch.record.treasury,
      },
      deployer,
      strategy: picker.kind === "passkey" ? "batched" : "sequential",
      effects: {
        call: (target) => ethCall(getRpcEndpoint(), target.to, target.data),
        send: async (call) => {
          const result = await sender.sendCalls([toSenderCall(call)]);
          return { txHash: result.txHash, status: "success" as const };
        },
        sendBatch: async (calls) => {
          const result = await sender.sendCalls(calls.map(toSenderCall));
          return { txHash: result.txHash, status: "success" as const };
        },
        isDeployed: (tokenAddress) =>
          isContractDeployed(getRpcEndpoint(), tokenAddress),
      },
      link: (token) =>
        onLink({
          id: launch.record.id,
          name: launch.record.name,
          pitch: launch.record.pitch,
          stage: launch.record.stage,
          chainId: launch.record.chainId ?? "11155111",
          currency: launch.record.currency ?? "",
          floorPrice: launch.record.floorPrice ?? "",
          tickSpacing: launch.record.tickSpacing ?? "",
          requiredRaised: launch.record.requiredRaised ?? "",
          auction: launch.record.auction ?? "",
          token,
          // Desktop `mintHooks.linkRecord` writes the deployer back as
          // treasury (the v1 gate requires deployer == treasury anyway).
          treasury: deployer,
          admission: launch.record.admission,
          channels: launch.record.channels,
        }),
      dispatch,
      state,
    };
  };

  const start = async () => {
    setRunning(true);
    try {
      await runMintAttempt(await attemptInput(), "fresh");
    } catch (err) {
      toast.error(senderErrorMessage(err, "Deploy failed."));
    } finally {
      setRunning(false);
    }
  };

  const retry = async () => {
    setRunning(true);
    try {
      const kind = await retryMintAttempt(await attemptInput());
      if (kind === "nothing") toast.error("Nothing left to retry.");
    } catch (err) {
      toast.error(senderErrorMessage(err, "Retry failed."));
    } finally {
      setRunning(false);
    }
  };

  const planToRetry = retryPlan(state);
  const busy =
    state.phase === "preparing" ||
    state.phase === "running" ||
    state.phase === "linking";
  return (
    <div className="mt-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <h3 className="text-sm font-semibold text-black dark:text-white">
        Deploy token here
      </h3>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        Runs the deploy script&apos;s three calls in the browser. The passkey
        path sends them as one sponsored, atomic UserOp; the wallet path sends
        three sequential transactions.
      </p>
      <SenderPickerControls state={picker} testIdPrefix="mint-" />
      <ol className="mt-3 flex flex-col gap-1">
        {MINT_STEPS.map((step, index) => (
          <li
            className="flex items-center justify-between text-sm text-black/80 dark:text-white/80"
            key={step.id}
          >
            <span>{step.label}</span>
            <span data-testid={`mint-step-${step.id}`}>
              {state.steps[index].status}
              {state.steps[index].txHash
                ? ` · ${state.steps[index].txHash}`
                : ""}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between text-sm text-black/80 dark:text-white/80">
          <span>Record mirror (token tag)</span>
          <span data-testid="mint-step-link">
            {state.phase === "linking"
              ? "linking"
              : state.phase === "success"
                ? "done"
                : state.failure?.stage === "link"
                  ? "failed"
                  : "pending"}
          </span>
        </li>
      </ol>
      {state.failure ? (
        <p
          className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200"
          data-testid="mint-failure"
        >
          {state.failure.stage === "prepare"
            ? `Preflight blocked (${state.failure.check}) — ${state.failure.reason}`
            : state.failure.stage === "link"
              ? `Mirror failed — the deploy landed at ${state.tokenAddress ?? "the computed address"}; only the record write needs retrying. ${state.failure.reason}`
              : `${MINT_STEPS[state.failure.stepIndex ?? 0].label} failed — ${state.failure.reason}`}
        </p>
      ) : null}
      {state.phase === "success" ? (
        <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          Deployed and linked: {state.tokenAddress}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button
          data-testid="mint-deploy"
          disabled={busy || running || state.phase === "success"}
          onClick={() => void start()}
          size="sm"
          type="button"
        >
          {busy || running ? "Working…" : "Deploy token"}
        </Button>
        {planToRetry ? (
          <Button
            data-testid="mint-retry"
            disabled={busy || running}
            onClick={() => void retry()}
            size="sm"
            type="button"
            variant="outline"
          >
            {planToRetry.kind === "record"
              ? "Retry record write"
              : `Retry from step ${planToRetry.resumeAt + 1}`}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Mint handoff: copy-paste CLI command + paste-and-verify to link back. */
export function TokenMintPanel({
  launch,
  onLink,
  saving,
}: {
  launch: Launch;
  onLink: (input: CreateLaunchInput) => Promise<void>;
  saving: boolean;
}) {
  const plan = launch.record.tokenPlan;
  const [treasury, setTreasury] = useState(launch.record.treasury ?? "");
  const [address, setAddress] = useState("");
  const [verifyState, setVerifyState] = useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  if (!plan) return null;
  const command = mintCommandForPlan({
    tokenName: plan.name,
    symbol: plan.symbol,
    supply: plan.supply,
    treasury: treasury || "<treasury-address>",
  });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success("Command copied.");
    } catch {
      toast.error("Copy failed — select the text manually.");
    }
  };
  const link = async () => {
    if (!isEvmAddress(address)) return;
    setVerifyState("checking");
    try {
      const ok = await isContractDeployed(getRpcEndpoint(), address.trim());
      if (!ok) {
        setVerifyState("missing");
        return;
      }
      setVerifyState("ok");
      await onLink({
        id: launch.record.id,
        name: launch.record.name,
        pitch: launch.record.pitch,
        stage: launch.record.stage,
        chainId: launch.record.chainId ?? "11155111",
        currency: launch.record.currency ?? "",
        floorPrice: launch.record.floorPrice ?? "",
        tickSpacing: launch.record.tickSpacing ?? "",
        requiredRaised: launch.record.requiredRaised ?? "",
        auction: launch.record.auction ?? "",
        token: address.trim(),
        treasury: launch.record.treasury ?? "",
        admission: launch.record.admission,
        channels: launch.record.channels,
      });
    } catch {
      setVerifyState("error");
    }
  };
  return (
    <Card className="p-4">
      <h2 className="text-base font-semibold">Mint {plan.symbol}</h2>
      <p className="mt-1 text-sm text-black/60 dark:text-white/60">
        {plan.supply} {plan.symbol} · reserve-backed apptoken. Deploy from this
        browser below, or run the CLI where your keys live and paste the address
        back here.
      </p>
      <DeployTokenFlow launch={launch} onLink={onLink} />
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 dark:bg-white/10">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">
          {command}
        </code>
        <Button
          onClick={() => void copy()}
          size="sm"
          type="button"
          variant="ghost"
        >
          Copy
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium" htmlFor="mint-treasury">
            Treasury
          </label>
          <Input
            id="mint-treasury"
            className="mt-1"
            onChange={(e) => setTreasury(e.target.value)}
            placeholder="0x…"
            value={treasury}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="mint-address">
            Minted token address
          </label>
          <span className="mt-1 flex gap-1">
            <Input
              id="mint-address"
              onChange={(e) => {
                setAddress(e.target.value);
                setVerifyState("idle");
              }}
              placeholder="0x…"
              value={address}
            />
            <Button
              disabled={
                !isEvmAddress(address) || saving || verifyState === "checking"
              }
              onClick={() => void link()}
              size="sm"
              type="button"
              variant="outline"
            >
              {verifyState === "checking" ? "…" : "Link"}
            </Button>
          </span>
        </div>
      </div>
      {verifyState === "missing" ? (
        <p className="mt-1 text-xs text-amber-600">
          No contract at this address on the configured RPC.
        </p>
      ) : null}
      {verifyState === "error" ? (
        <p className="mt-1 text-xs text-amber-600">
          Couldn&apos;t reach the chain. Check the RPC endpoint.
        </p>
      ) : null}
    </Card>
  );
}
