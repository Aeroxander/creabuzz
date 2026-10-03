import { UnauditedNotice } from "./UnauditedNotice";
import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/button";
import { useChannels } from "@/features/channels/use-channels";
import { SignRecovery } from "@/features/identity/ui/SignRecovery";
import { useProject } from "@/features/projects/use-projects";
import {
  isEvmAddress,
  LAUNCH_DEFAULTS,
  suggestSymbol,
  type VestingConfig,
} from "../models";
import type { CreateLaunchInput } from "../use-launches";
import {
  STANDARD_ALLOCATION,
  allocationIssue,
  type SupplyAllocation,
} from "../lib/allocation";
import {
  DEFAULT_PERFORMANCE_TRANCHES,
  validateVesting,
} from "../lib/vesting-params";
import { standardLaunchPreset } from "../lib/launch-params";
import { formatMoney, formatQ96PerToken } from "../lib/amounts";
import { atomicToPrice, unitsToPlain, type SaleKind } from "../lib/sale-plans";
import {
  currencyChoices,
  ETH,
  saleCurrencyFor,
  type SaleCurrency,
} from "../lib/sale-currency";
import { describeSaleBlocks } from "../lib/time-blocks";
import {
  budgetCapMessage,
  budgetForShare,
  budgetShare,
  buildLegacyInput,
  canPublish,
  canSaveEdit,
  deriveTokenName,
  effectiveLaunchId,
  initialWizardState,
  nowSeconds,
  parseRawBlocks,
  patchForPrice,
  patchForRaiseTarget,
  planForWizard,
  publishIssues,
  renumberMilestones,
  totalFromTranche,
  trancheFromTotal,
  validationWindowFor,
  wizardStepIssues,
  wizardToCreateInput,
  WIZARD_STEPS,
  type FormState,
  type MilestoneRow,
  type PricingMode,
  type WizardState,
} from "../lib/wizard";
import {
  documentedBlockTimeSeconds,
  localUsdcAddress,
  ethBlockNumber,
  getRpcEndpoint,
  isContractDeployed,
  measureChainBlockTime,
  type ChainBlockTime,
} from "../chain";
import {
  equalMilestoneSplit,
  MILESTONE_TEMPLATES,
  milestonesFromTemplate,
} from "../lib/unlock-plans";
import { Modal } from "./Modal";
import {
  AdvancedFields,
  type AdvancedFieldsState,
} from "./create-wizard/AdvancedFields";
import {
  WizardSteps,
  type WizardController,
} from "./create-wizard/WizardSteps";

type TokenMode = "mint" | "import";

export function CreateLaunchDialog({
  isCreating,
  onCreate,
  onClose,
  initial,
  idea,
  relaunchNote,
  publishError,
}: {
  isCreating: boolean;
  onCreate: (input: CreateLaunchInput) => Promise<void>;
  onClose: () => void;
  initial?: Partial<CreateLaunchInput>;
  /**
   * An idea being turned into a sale. Unlike `initial` this is still a create:
   * the sale terms are chosen here, while the idea's identity (id, name, pitch,
   * cover, category, rooms) is carried over and republished onto the same record.
   */
  idea?: Partial<CreateLaunchInput>;
  /** Shown as an info banner — e.g. "this republishes the same record". */
  relaunchNote?: string;
  /**
   * Why the last publish attempt failed. Rendered by `SignRecovery` so a
   * locked passkey shows the unlock action beside the refusal instead of
   * leaving "Unlock your passkey before this browser can sign." with no way
   * forward (Review-Proven Rule 6).
   */
  publishError?: string | null;
}) {
  const isEdit = Boolean(initial);
  /** What the identity fields start from: the record being edited, or the idea. */
  const seed = initial ?? idea;

  const [id, setId] = useState(seed?.id ?? "");
  const [name, setName] = useState(seed?.name ?? "");
  const [pitch, setPitch] = useState(seed?.pitch ?? "");
  const [longPitch, setLongPitch] = useState(seed?.longPitch ?? "");
  const [ipList, setIpList] = useState(seed?.ipList?.join("\n") ?? "");
  const [updateCadence, setUpdateCadence] = useState(seed?.updateCadence ?? "");
  const [image, setImage] = useState(seed?.image ?? "");
  const [category, setCategory] = useState(seed?.category ?? "");
  const [chainId, setChainId] = useState<string>(
    initial?.chainId ?? LAUNCH_DEFAULTS.chainId,
  );
  // What the sale raises in decides every unit on the money steps: ETH has 18
  // decimals, USDC 6. Derived, never stored twice.
  const localUsdc = localUsdcAddress();
  // A new launch starts on USDC where the chain has one (steady dollar prices,
  // and what the app's defaults were written for), else on ETH. An existing
  // record keeps exactly what it published.
  const [currency, setCurrency] = useState(
    initial
      ? (initial.currency ?? "")
      : (currencyChoices(chainId, localUsdc)[0]?.value ?? ""),
  );
  const saleCurrency = saleCurrencyFor(currency, chainId, localUsdc);
  const currencyOptions = currencyChoices(chainId, localUsdc);
  const [floorPrice, setFloorPrice] = useState<string>(
    initial?.floorPrice ?? LAUNCH_DEFAULTS.floorPrice,
  );
  const [tickSpacing, setTickSpacing] = useState<string>(
    initial?.tickSpacing ?? LAUNCH_DEFAULTS.tickSpacing,
  );
  const [requiredRaised, setRequiredRaised] = useState<string>(
    initial?.requiredRaised ?? LAUNCH_DEFAULTS.requiredRaised,
  );
  const [budget, setBudget] = useState<string>(initial?.budget ?? "");
  const [auction, setAuction] = useState(initial?.auction ?? "");
  const [treasury, setTreasury] = useState(initial?.treasury ?? "");
  const [admission, setAdmission] = useState<"curated" | "community">(
    initial?.admission ?? LAUNCH_DEFAULTS.admission,
  );
  const [allocation, setAllocation] = useState<SupplyAllocation>(
    () => initial?.allocation ?? { ...STANDARD_ALLOCATION },
  );
  const allocationMessage = allocationIssue(allocation);
  const [vesting, setVesting] = useState<VestingConfig | null>(() =>
    initial?.vesting
      ? { ...initial.vesting, tranches: [...initial.vesting.tranches] }
      : {
          cliffBlocks: 3_110_400,
          tranches: DEFAULT_PERFORMANCE_TRANCHES.map((t) => ({ ...t })),
          twapWindow: null,
        },
  );
  /**
   * Whether the record already carried a ladder, and whether it was touched
   * here: an untouched default is not published (`publishableVesting`), and a
   * record's own ladder is never dropped by a save.
   */
  const [vestingPresent] = useState(Boolean(initial?.vesting));
  const [vestingDirty, setVestingDirty] = useState(false);
  const vestingIssues = validateVesting(vesting);
  const [boundChannels, setBoundChannels] = useState<string[]>(
    seed?.channels ?? [],
  );
  const [asAgent, setAsAgent] = useState(Boolean(initial?.asAgent));
  const { data: channelList } = useChannels();
  const [tokenMode, setTokenMode] = useState<TokenMode>(
    initial?.token ? "import" : "mint",
  );
  const [tokenName, setTokenName] = useState(
    () =>
      initial?.tokenPlan?.name ??
      (idea?.name?.trim() ? `${idea.name.trim()} Token` : ""),
  );
  const [symbol, setSymbol] = useState(
    () =>
      initial?.tokenPlan?.symbol ??
      (idea?.name?.trim() ? suggestSymbol(idea.name) : ""),
  );
  const [supply, setSupply] = useState<string>(
    () => initial?.tokenPlan?.supply ?? LAUNCH_DEFAULTS.supply,
  );
  /**
   * The number the wizard's "Total supply" shows: the record stores the sale
   * tranche, so this is that tranche turned back into the total the founder
   * thinks in (`totalFromTranche`). Edited text goes through
   * `trancheFromTotal` on the way to `supply`, so the two can never drift.
   */
  const [totalSupplyText, setTotalSupplyText] = useState(() =>
    totalFromTranche(
      initial?.tokenPlan?.supply ?? LAUNCH_DEFAULTS.supply,
      (initial?.allocation ?? STANDARD_ALLOCATION).sale,
    ),
  );
  const [importAddress, setImportAddress] = useState(initial?.token ?? "");
  const [verifyState, setVerifyState] = useState<
    "idle" | "checking" | "ok" | "missing" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  // Raw block overrides — the Advanced drawer's copy of what the wizard
  // derives from the calendar. Empty means "use the conversion".
  const [startBlockRaw, setStartBlockRaw] = useState(
    initial?.startBlock?.toString() ?? "",
  );
  const [endBlockRaw, setEndBlockRaw] = useState(
    initial?.endBlock?.toString() ?? "",
  );
  const [claimBlockRaw, setClaimBlockRaw] = useState(
    initial?.claimBlock?.toString() ?? "",
  );

  // ── The wizard's own state ──────────────────────────────────────────────
  const [wizard, setWizard] = useState<WizardState>(() =>
    initialWizardState(
      initial
        ? {
            // Edit renders the same step components, so the plain-language
            // boxes must show the record's own terms. Display mirroring only —
            // nothing re-derives on load.
            price: q96ToPlainPrice(
              initial.floorPrice ?? "",
              saleCurrency.decimals,
            ),
            raiseTarget: initial.requiredRaised
              ? unitsToPlain(initial.requiredRaised, saleCurrency.decimals)
              : "",
          }
        : {},
    ),
  );
  const patch = (next: Partial<WizardState>) =>
    setWizard((previous) => ({ ...previous, ...next }));
  /** The instant the dialog opened — the conversion line stays stable. */
  const [plannedAt] = useState(() => nowSeconds());

  /**
   * Measure this chain's block time for the time → block conversion.
   *
   * Fenced by `chainId` (Review-Proven Rule 2): a measurement that comes back
   * after the founder switched chains is dropped instead of converting dates
   * against the wrong chain.
   */
  const [blockTime, setBlockTime] = useState<ChainBlockTime | null>(null);
  useEffect(() => {
    if (isEdit) return undefined;
    let cancelled = false;
    void (async () => {
      const measured = await measureChainBlockTime(getRpcEndpoint(), chainId);
      if (!cancelled) setBlockTime(measured);
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, isEdit]);

  const rawBlocks = parseRawBlocks({
    startBlock: startBlockRaw,
    endBlock: endBlockRaw,
    claimBlock: claimBlockRaw,
  });
  const initialBlocks =
    initial?.startBlock !== undefined &&
    initial?.endBlock !== undefined &&
    initial?.claimBlock !== undefined
      ? {
          startBlock: initial.startBlock,
          endBlock: initial.endBlock,
          claimBlock: initial.claimBlock,
        }
      : null;

  const form: FormState = {
    id,
    name,
    pitch,
    longPitch,
    ipList,
    updateCadence,
    image,
    category,
    chainId,
    currency,
    floorPrice,
    tickSpacing,
    requiredRaised,
    budget,
    auction,
    treasury,
    admission,
    channels: boundChannels,
    allocation,
    vesting,
    vestingPresent,
    vestingDirty,
    tokenMode,
    tokenName,
    symbol,
    supply,
    importAddress,
    asAgent,
    startBlock:
      rawBlocks !== null && rawBlocks !== "incomplete"
        ? rawBlocks.startBlock
        : (initialBlocks?.startBlock ?? null),
    endBlock:
      rawBlocks !== null && rawBlocks !== "incomplete"
        ? rawBlocks.endBlock
        : (initialBlocks?.endBlock ?? null),
    claimBlock:
      rawBlocks !== null && rawBlocks !== "incomplete"
        ? rawBlocks.claimBlock
        : (initialBlocks?.claimBlock ?? null),
    unlocks: initial?.unlocks ?? null,
    daoAtGraduation: initial?.daoAtGraduation ?? null,
  };

  const launchId = effectiveLaunchId(form);
  // Recomputed per render on purpose: it is a few lines of integer maths, and
  // a memo would have to depend on half the form to stay honest.
  const plan =
    blockTime && !isEdit ? planForWizard(wizard, blockTime, plannedAt) : null;

  const validationWindow = isEdit
    ? null
    : validationWindowFor(
        wizard,
        rawBlocks !== null && rawBlocks !== "incomplete"
          ? rawBlocks
          : plan
            ? {
                startBlock: plan.startBlock,
                endBlock: plan.endBlock,
                claimBlock: plan.claimBlock,
              }
            : null,
      );
  const paramIssues = publishIssues(form, validationWindow);
  const stepIssues = wizardStepIssues(wizard, form, wizard.step);

  // One validator owns both gates (lib/wizard.ts): `canPublish` for a create,
  // `canSaveEdit` for a save. No local gate — a surface that validates itself
  // is a surface that can drift from the wizard (the editSurfaceContract test
  // binds this).
  const publishEnabled = isEdit
    ? canSaveEdit(wizard, form)
    : canPublish(wizard, form, validationWindow) && rawBlocks !== "incomplete";

  // ── Money derivation: the wizard's plain numbers → the record's ─────────

  const applyMoney = (next: {
    kind?: SaleKind;
    mode?: PricingMode;
    price?: string;
    raiseTarget?: string;
    supply?: string;
    /** Decimals of a currency just chosen (state has not caught up yet). */
    decimals?: number;
  }) => {
    // Editing an existing launch never re-derives the money: the record's own
    // terms are what a save must keep, and the wizard's pricing is a create-
    // time convenience.
    if (isEdit) return;
    const kind = next.kind ?? wizard.saleKind;
    const mode = next.mode ?? wizard.pricingMode;
    const price = next.price ?? wizard.price;
    const raiseTarget = next.raiseTarget ?? wizard.raiseTarget;
    const supplyValue = next.supply ?? supply;
    const decimals = next.decimals ?? saleCurrency.decimals;
    const money =
      mode === "price"
        ? patchForPrice(price, kind, supplyValue, decimals)
        : patchForRaiseTarget(raiseTarget, kind, supplyValue, decimals);
    if (!money) return;
    setFloorPrice(money.floorPrice);
    setTickSpacing(money.tickSpacing);
    setRequiredRaised(money.requiredRaised);
  };

  const onName = (next: string) => {
    // Keep the suggested token defaults in step with the name while the
    // founder has not chosen their own.
    const previousTokenName = `${name} Token`;
    const previousSymbol = suggestSymbol(name);
    setTokenName((prev) =>
      prev === "" || prev === previousTokenName
        ? next.trim() === ""
          ? ""
          : `${next.trim()} Token`
        : prev,
    );
    setSymbol((prev) =>
      prev === "" || prev === previousSymbol ? suggestSymbol(next) : prev,
    );
    setName(next);
  };

  const onTotalSupply = (next: string) => {
    setTotalSupplyText(next);
    const tranche = trancheFromTotal(next, allocation.sale);
    setSupply(tranche);
    applyMoney({ supply: tranche });
  };

  const onSaleKind = (kind: SaleKind) => {
    patch({ saleKind: kind });
    applyMoney({ kind });
  };

  const onPricingMode = (mode: PricingMode) => {
    if (mode === wizard.pricingMode) return;
    if (mode === "raise" && wizard.raiseTarget.trim() === "") {
      // Seed the target from the line the form already has, so switching the
      // way you state it does not blank the terms.
      const seeded = unitsToPlain(requiredRaised, saleCurrency.decimals);
      patch({ pricingMode: mode, raiseTarget: seeded || wizard.raiseTarget });
      applyMoney({ mode, raiseTarget: seeded });
      return;
    }
    patch({ pricingMode: mode });
    applyMoney({ mode });
  };

  const onPrice = (value: string) => {
    patch({ price: value });
    if (isEdit) {
      // Edit writes exactly the field the box names — the floor — the same
      // semantics as the raw override below it. The create-time triple
      // derivation stays create-time (`applyMoney`).
      const money = patchForPrice(
        value,
        wizard.saleKind,
        supply,
        saleCurrency.decimals,
      );
      if (money) setFloorPrice(money.floorPrice);
      return;
    }
    applyMoney({ price: value, mode: "price" });
  };

  const onRaiseTarget = (value: string) => {
    patch({ raiseTarget: value });
    if (isEdit) {
      const money = patchForRaiseTarget(
        value,
        wizard.saleKind,
        supply,
        saleCurrency.decimals,
      );
      if (money) setRequiredRaised(money.requiredRaised);
      return;
    }
    applyMoney({ raiseTarget: value, mode: "raise" });
  };

  /**
   * Start the money fields over in `chosen`. A price typed in dollars means
   * nothing in ETH (and the reverse), so a change of currency never carries the
   * old numbers across: it re-seeds a sensible starting point in the new units,
   * and the founder edits from there.
   */
  const seedMoney = (chosen: SaleCurrency) => {
    const price =
      chosen.kind === "eth" ? ETH_DEFAULT_PRICE : USDC_DEFAULT_PRICE;
    patch({ price, raiseTarget: "", pricingMode: "price" });
    applyMoney({
      price,
      mode: "price",
      raiseTarget: "",
      decimals: chosen.decimals,
    });
  };

  const onCurrency = (chosen: SaleCurrency) => {
    if (chosen.value === currency.trim().toLowerCase()) return;
    setCurrency(chosen.value);
    if (!isEdit) seedMoney(chosen);
  };

  /**
   * A chain change keeps the founder's CHOICE (USDC or ETH), not the address:
   * USDC lives at a different address on every chain, and where a chain has no
   * known USDC the sale falls back to ETH rather than pointing at an address
   * that is not the token.
   */
  const onChain = (nextChain: string) => {
    setChainId(nextChain);
    if (isEdit || saleCurrency.kind === "custom") return;
    const next = currencyChoices(nextChain, localUsdc);
    const keep =
      next.find((choice) => choice.kind === saleCurrency.kind) ?? ETH;
    if (keep.value !== saleCurrency.value) {
      setCurrency(keep.value);
      seedMoney(keep);
    }
  };

  const quickStart = () => {
    setChainId(LAUNCH_DEFAULTS.chainId);
    setFloorPrice(LAUNCH_DEFAULTS.floorPrice);
    setTickSpacing(LAUNCH_DEFAULTS.tickSpacing);
    setRequiredRaised(LAUNCH_DEFAULTS.requiredRaised);
    setBudget("");
    setAdmission(LAUNCH_DEFAULTS.admission);
    setAsAgent(false);
    setBoundChannels(initial?.channels ?? []);
    if (name.trim() !== "") {
      setTokenName(`${name.trim()} Token`);
      setSymbol((s) => s || suggestSymbol(name));
    }
    if (saleCurrency.kind === "eth") {
      seedMoney(saleCurrency);
    } else {
      patch({
        price: atomicToPrice(BigInt(LAUNCH_DEFAULTS.floorPrice)),
        raiseTarget: "",
      });
    }
  };

  /**
   * Fill in the shape a project normally wants: a fifth of the supply at a cent
   * per token for a 10M valuation, graduating if it raises 15% of the sale's
   * floor value. Nothing is locked in — the fields stay editable.
   */
  const applyRecommendedTerms = () => {
    const preset = standardLaunchPreset({
      startBlock: 0n,
      totalSupply: 10n ** 18n * 1_000_000_000n,
    });
    const tranche = Number(preset.supply / 10n ** 18n).toString();
    setSupply(tranche);
    setTotalSupplyText(totalFromTranche(tranche, allocation.sale));
    if (saleCurrency.kind === "eth") {
      // The preset is a dollar valuation; there is no dollar anchor for ETH, so
      // it starts from the ETH default price instead.
      seedMoney(saleCurrency);
      return;
    }
    setFloorPrice(preset.floorPrice.toString());
    setTickSpacing(preset.tickSpacing.toString());
    setRequiredRaised(preset.requiredCurrencyRaised.toString());
    patch({
      price: atomicToPrice(preset.floorPrice),
      raiseTarget: unitsToPlain(preset.requiredCurrencyRaised),
    });
  };

  const verifyImport = async () => {
    if (!isEvmAddress(importAddress)) {
      setVerifyState("error");
      return;
    }
    setVerifyState("checking");
    try {
      const ok = await isContractDeployed(
        getRpcEndpoint(),
        importAddress.trim(),
      );
      setVerifyState(ok ? "ok" : "missing");
    } catch {
      setVerifyState("error");
    }
  };

  const advance = () => {
    if (stepIssues.length > 0) return;
    const next =
      WIZARD_STEPS[WIZARD_STEPS.findIndex((s) => s.key === wizard.step) + 1];
    if (next) patch({ step: next.key });
  };

  const back = () => {
    const index = WIZARD_STEPS.findIndex((s) => s.key === wizard.step);
    const previous = WIZARD_STEPS[index - 1];
    if (previous) patch({ step: previous.key });
  };

  const runSubmit = async () => {
    if (isCreating) return;
    setError(null);
    if (isEdit) {
      void onCreate({
        ...buildLegacyInput(form),
        stage: initial?.stage ?? "draft",
      });
      return;
    }
    if (rawBlocks === "incomplete") {
      setError(
        "Raw blocks: set all three, with claims opening at or after the end.",
      );
      return;
    }
    /**
     * Re-read the head so the window starts from *now*, not from when the
     * dialog opened; the block time itself stays the measured one shown in the
     * conversion line, so what was displayed is what is written.
     */
    let head = blockTime?.head ?? null;
    try {
      head = Number(await ethBlockNumber(getRpcEndpoint()));
      if (!Number.isSafeInteger(head) || head < 0)
        head = blockTime?.head ?? null;
    } catch {
      head = blockTime?.head ?? null;
    }
    const planAtPublish = planForWizard(
      wizard,
      {
        head,
        secondsPerBlock:
          blockTime?.secondsPerBlock ?? documentedBlockTimeSeconds(chainId),
        source: blockTime?.source ?? "default",
      },
      nowSeconds(),
    );
    const input = wizardToCreateInput(form, wizard, {
      plan: planAtPublish,
      rawBlocks,
      stage: initial?.stage ?? "draft",
    });
    // The idea's rooms ride along, or the republish would erase them.
    void onCreate(idea?.chat ? { ...input, chat: idea.chat } : input);
  };

  /**
   * The one entry point the footer and the passkey-unlock action share.
   * Sync, so `SignRecovery` can re-run the exact intent it interrupted
   * (the contract in `gatedRecoveryContract.test.mjs` pins this shape).
   */
  const submit = () => {
    void runSubmit();
  };

  // ── Step 3/4 details ─────────────────────────────────────────────────────

  const budgetShareValue = budgetShare(form.budget, form.requiredRaised);
  const capLine = budgetCapMessage(form.budget, form.requiredRaised);
  const project = useProject(launchId).project;
  const equity = project
    ? project.team.map((member) => ({
        label: member.role.label,
        pct: member.pct,
      }))
    : null;

  const setMilestoneRows = (rows: MilestoneRow[]) =>
    patch({ milestones: renumberMilestones(rows) });

  /**
   * Adding or removing redistributes equally, so the sum stays 100 by
   * construction — the only way it can drift afterwards is by editing a row,
   * which is exactly when the founder should see the sum line move.
   */
  const resizeMilestones = (rows: MilestoneRow[]) => {
    const split = equalMilestoneSplit(rows.length);
    patch({
      milestones: rows.map((row, index) => ({
        ...row,
        claim: `m${index + 1}`,
        percent: split[index] ?? 0,
      })),
    });
  };

  const conversion =
    blockTime === null
      ? "Reading this chain's block time…"
      : plan === null
        ? blockTime.head === null
          ? "This chain could not be read, so the launch will publish with no block window. Set raw blocks in Advanced if you know them."
          : "Pick an end date in the future to see the window."
        : `${describeSaleBlocks(plan)}${
            rawBlocks !== null && rawBlocks !== "incomplete"
              ? " Advanced overrides this window."
              : ""
          }`;

  const moneySummary =
    form.requiredRaised.trim() === "" || form.requiredRaised.trim() === "0"
      ? "No graduation line yet — pick a price so there is one."
      : `Priced at ${formatQ96PerToken(form.floorPrice, {
          currencyDecimals: saleCurrency.decimals,
          ...(saleCurrency.kind === "eth" ? { unit: "ETH" } : {}),
        })} a token. Graduates at ${formatMoney(form.requiredRaised, saleCurrency)} raised; below that, every bid refunds.`;

  const controller: WizardController = {
    wizard,
    patch,
    editing: isEdit,
    token: {
      name,
      onName,
      symbol,
      onSymbol: setSymbol,
      totalSupply: totalSupplyText,
      onTotalSupply,
      launchId,
      tokenName: tokenName.trim() === "" ? deriveTokenName(name) : tokenName,
      pitch,
      onPitch: setPitch,
      image,
      onImage: setImage,
      category,
      onCategory: setCategory,
    },
    supply: {
      allocation,
      issue: allocationMessage,
      onReset: () => setAllocation({ ...STANDARD_ALLOCATION }),
      onChange: (key, value) => {
        setAllocation((previous) => ({ ...previous, [key]: value }));
        // The tranche is derived from the total: a sale-share change
        // re-derives it, because the tokenomics card turns the tranche back
        // into the total with this same share.
        if (key === "sale") setSupply(trancheFromTotal(totalSupplyText, value));
      },
    },
    sale: {
      currency: saleCurrency,
      currencyChoices: currencyOptions,
      onCurrency,
      summary: moneySummary,
      conversion,
      onSaleKind,
      onPricingMode,
      onPrice,
      onRaiseTarget,
    },
    unlocks: {
      issues: wizardStepIssues(wizard, form, "unlocks"),
      onLabel: (index, value) =>
        setMilestoneRows(
          wizard.milestones.map((row, position) =>
            position === index ? { ...row, label: value } : row,
          ),
        ),
      onPercent: (index, value) =>
        setMilestoneRows(
          wizard.milestones.map((row, position) =>
            position === index
              ? { ...row, percent: Number(value.replace(/\D/g, "")) || 0 }
              : row,
          ),
        ),
      onAdd: () => {
        if (wizard.milestones.length >= 4) return;
        resizeMilestones([
          ...wizard.milestones,
          { claim: "", label: "", percent: 0 },
        ]);
      },
      onRemove: (index) => {
        if (wizard.milestones.length <= 2) return;
        resizeMilestones(
          wizard.milestones.filter((_, position) => position !== index),
        );
      },
      adoptTemplate: (key) => {
        const template = MILESTONE_TEMPLATES.find((entry) => entry.key === key);
        if (!template) return;
        patch({
          milestones: milestonesFromTemplate(template).map((row) => ({
            claim: row.claim,
            label: row.label,
            percent: row.percent,
          })),
        });
      },
      customLadderNote:
        vestingDirty && !isEdit
          ? "A custom price ladder from Advanced also applies on top of this plan."
          : null,
    },
    dao: {
      share: budgetShareValue,
      onShare: (value) => setBudget(budgetForShare(form.requiredRaised, value)),
      capNote: capLine
        ? `${capLine} Publishing still works — the launch shows the warning. Summoning the DAO with a budget over the cap is refused.`
        : null,
      equity,
      equityNote: project
        ? `${equity?.length ?? 0} seat${(equity?.length ?? 0) === 1 ? "" : "s"} from the Project Board — the summon mints exactly this map.`
        : "No Project Board entry for this launch yet. Seats are minted from the board's map when you summon; the founder holds everything until then.",
    },
    stepIssues,
  };

  /** Everything the Advanced drawer / edit body edits, in one bag. */
  const legacy: AdvancedFieldsState = {
    id,
    setId,
    onName,
    name,
    initial,
    longPitch,
    setLongPitch,
    ipList,
    setIpList,
    updateCadence,
    setUpdateCadence,
    tokenMode,
    setTokenMode,
    tokenName,
    setTokenName,
    importAddress,
    setImportAddress,
    verifyState,
    setVerifyState,
    verifyImport,
    chainId,
    setChainId: onChain,
    admission,
    setAdmission,
    currency,
    setCurrency,
    saleCurrency,
    vesting,
    setVesting,
    markVestingDirty: () => setVestingDirty(true),
    vestingIssues,
    floorPrice,
    onFloorChange: (value) => {
      setFloorPrice(value);
      // The wizard's price box speaks per-token plain units; keep it showing
      // what this raw override actually means.
      setWizard((previous) => ({
        ...previous,
        price: q96ToPlainPrice(value, saleCurrency.decimals),
      }));
    },
    requiredRaised,
    setRequiredRaised,
    tickSpacing,
    setTickSpacing,
    startBlockRaw,
    setStartBlockRaw,
    endBlockRaw,
    setEndBlockRaw,
    claimBlockRaw,
    setClaimBlockRaw,
    rawBlocks,
    budget,
    setBudget,
    auction,
    setAuction,
    treasury,
    setTreasury,
    channelList,
    boundChannels,
    setBoundChannels,
    asAgent,
    setAsAgent,
  };

  return (
    <Modal label={isEdit ? "Edit launch" : "New launch"} onClose={onClose} wide>
      <h2 className="text-lg font-semibold text-black dark:text-white">
        {isEdit ? "Edit launch" : "New launch"}
      </h2>
      <UnauditedNotice />
      {relaunchNote ? (
        <p
          className="mt-2 rounded-lg bg-blue-50 p-3 text-sm text-blue-800 dark:bg-blue-950 dark:text-blue-200"
          data-testid="launch-relaunch-note"
        >
          {relaunchNote}
        </p>
      ) : null}
      <div className="mt-3 flex max-h-[68vh] flex-col gap-3 overflow-y-auto pr-1">
        {isEdit ? (
          <>
            <WizardSteps controller={controller} variant="all" />
            <AdvancedFields {...legacy} />
          </>
        ) : (
          <>
            <WizardSteps controller={controller} />
            <details
              className="rounded-xl border border-black/15 px-3 py-2 dark:border-white/15"
              data-testid="launch-advanced"
            >
              <summary className="cursor-pointer text-sm font-medium select-none text-black dark:text-white">
                Advanced
                <span className="ml-2 text-xs font-normal text-black/50 dark:text-white/50">
                  exact values, raw blocks, cliffs and hooks
                </span>
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                <AdvancedFields {...legacy} />
              </div>
            </details>
          </>
        )}
        <SignRecovery
          className="mt-4"
          message={publishError ?? error}
          onUnlocked={() => submit()}
          showHeadline
          testId="launch-sign-recovery"
        />
        {paramIssues.length > 0 ? (
          <ul
            className="mt-2 space-y-0.5 text-xs"
            data-testid="launch-param-issues"
          >
            {paramIssues.map((issue) => (
              <li
                className={
                  issue.severity === "error"
                    ? "text-red-600 dark:text-red-400"
                    : "text-amber-700 dark:text-amber-300"
                }
                key={`${issue.field}-${issue.message}`}
              >
                {issue.severity === "error" ? "✗ " : "! "}
                {issue.field}: {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          data-testid="launch-recommended-terms"
          onClick={applyRecommendedTerms}
          size="sm"
          type="button"
          variant="outline"
        >
          Recommended terms
        </Button>
        <Button onClick={quickStart} size="sm" type="button" variant="ghost">
          Quick start defaults
        </Button>
        {!isEdit && wizard.step !== "token" ? (
          <Button onClick={back} size="sm" type="button" variant="ghost">
            Back
          </Button>
        ) : null}
        {!isEdit && wizard.step !== "dao" ? (
          <Button
            data-testid="wizard-continue"
            disabled={stepIssues.length > 0}
            onClick={advance}
            type="button"
          >
            Continue
          </Button>
        ) : (
          <Button
            disabled={!publishEnabled || isCreating}
            onClick={submit}
            type="button"
          >
            {isCreating
              ? "Publishing…"
              : isEdit
                ? "Save changes"
                : "Publish launch"}
          </Button>
        )}
      </div>
    </Modal>
  );
}

/** A raw Q96 floor (or anything unreadable) → the plain price box's text. */
function q96ToPlainPrice(value: string, currencyDecimals = 6): string {
  try {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    return atomicToPrice(BigInt(trimmed), currencyDecimals);
  } catch {
    return "";
  }
}
/**
 * Where an ETH sale starts. There is no dollar anchor for ETH (no oracle), so
 * this is only a starting point the founder edits: 0.000004 ETH a token.
 */
const ETH_DEFAULT_PRICE = "0.000004";
/** And a cent a token in USDC: what the wizard has always started from. */
const USDC_DEFAULT_PRICE = "0.01";
