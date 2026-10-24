import { useEffect, useReducer, useState } from "react";
import { CircleCheck, Info, LoaderCircle, Sprout, TriangleAlert } from "lucide-react";
import {
  TreeShapeSchema,
  gardenerAutonomyLevels,
  type BudgetSnapshot,
  type GardenerAutonomy,
  type KnowledgeControlsUpdate,
  type TreeShape
} from "@app/domain";
import type { Translator } from "@app/i18n";
import { knowledgeControlDomIds } from "../../../shared/settings-registry";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import {
  createKnowledgeControlsSaver,
  initialKnowledgeControlsState,
  knowledgeControlsReducer,
  monthlyCapMaxUsd,
  parseMonthlyCapInput,
  readKnowledgeControls,
  type KnowledgeControlsState
} from "./knowledge-controls-state";

const labelClass = "text-sm font-medium text-foreground";
const selectClass =
  "h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground";

const autonomyCopy = {
  off: {
    option: "settings.knowledge.autonomy.options.off",
    help: "settings.knowledge.autonomy.help.off"
  },
  suggest: {
    option: "settings.knowledge.autonomy.options.suggest",
    help: "settings.knowledge.autonomy.help.suggest"
  },
  auto: {
    option: "settings.knowledge.autonomy.options.auto",
    help: "settings.knowledge.autonomy.help.auto"
  }
} as const satisfies Record<GardenerAutonomy, { option: string; help: string }>;

const treeShapeCopy = {
  broad: {
    option: "settings.knowledge.treeShape.options.broad",
    help: "settings.knowledge.treeShape.help.broad"
  },
  balanced: {
    option: "settings.knowledge.treeShape.options.balanced",
    help: "settings.knowledge.treeShape.help.balanced"
  },
  deep: {
    option: "settings.knowledge.treeShape.options.deep",
    help: "settings.knowledge.treeShape.help.deep"
  }
} as const satisfies Record<TreeShape, { option: string; help: string }>;

export interface KnowledgeControlsViewProps {
  t: Translator;
  state: KnowledgeControlsState;
  /** The month's remote spend against the cap, once known; null while unknown or unavailable. */
  spend: BudgetSnapshot["money"] | null;
  onEdit: (change: KnowledgeControlsUpdate) => void;
  onRetry: () => void;
}

/**
 * Settings › Knowledge's six controls (F4 D13, T98). The only automation controls outside an
 * Advanced disclosure (E7): autonomy, the monthly cap on remote spending, pause, the shape of the
 * topic tree, and the two power conditions. Loading, a failed read (retryable), saving, saved and a
 * failed save are all shown; the controls always hold values, so there is no empty state.
 */
export function KnowledgeControlsView({
  t,
  state,
  spend,
  onEdit,
  onRetry
}: KnowledgeControlsViewProps) {
  return (
    <section
      aria-labelledby="knowledge-controls-title"
      className="grid content-start gap-5 rounded-2xl border border-border bg-surface p-5 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-soft text-accent">
          <Sprout className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 id="knowledge-controls-title" className="font-semibold text-foreground">
            {t("settings.knowledge.title")}
          </h3>
          <p className="mt-1 text-sm leading-5 text-secondary-foreground">
            {t("settings.knowledge.description")}
          </p>
        </div>
      </div>
      {state.phase === "loading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-secondary-foreground">
          <LoaderCircle
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("settings.knowledge.states.loading")}
        </p>
      ) : null}
      {state.phase === "error" ? (
        <div role="alert" className="grid gap-2 text-sm">
          <p className="flex items-center gap-2 text-danger">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("settings.knowledge.states.error")}
          </p>
          <Button type="button" className="w-fit" onClick={onRetry}>
            {t("settings.knowledge.states.retry")}
          </Button>
        </div>
      ) : null}
      {state.phase === "ready" ? (
        <ReadyControls t={t} state={state} spend={spend} onEdit={onEdit} />
      ) : null}
    </section>
  );
}

function ReadyControls({
  t,
  state,
  spend,
  onEdit
}: {
  t: Translator;
  state: Extract<KnowledgeControlsState, { phase: "ready" }>;
  spend: BudgetSnapshot["money"] | null;
  onEdit: (change: KnowledgeControlsUpdate) => void;
}) {
  const controls = state.shown;
  return (
    <div className="grid gap-5">
      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor={knowledgeControlDomIds.autonomy} className={labelClass}>
          {t("settings.knowledge.autonomy.label")}
        </Label>
        <select
          id={knowledgeControlDomIds.autonomy}
          className={selectClass}
          value={controls.autonomy}
          aria-describedby={`${knowledgeControlDomIds.autonomy}-help`}
          onChange={(event) => onEdit({ autonomy: event.target.value as GardenerAutonomy })}
        >
          {gardenerAutonomyLevels.map((level) => (
            <option key={level} value={level}>
              {t(autonomyCopy[level].option)}
            </option>
          ))}
        </select>
      </div>
      <p
        id={`${knowledgeControlDomIds.autonomy}-help`}
        className="-mt-3 text-xs leading-5 text-muted-foreground"
      >
        {t(autonomyCopy[controls.autonomy].help)}
      </p>

      <MonthlyCapField
        t={t}
        value={controls.monthlyCapUsd}
        spend={spend}
        onCommit={(monthlyCapUsd) => onEdit({ monthlyCapUsd })}
      />

      <SwitchRow
        id={knowledgeControlDomIds.paused}
        label={t("settings.knowledge.pause.label")}
        hint={t("settings.knowledge.pause.hint")}
        checked={controls.paused}
        onChange={(paused) => onEdit({ paused })}
      />

      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor={knowledgeControlDomIds.treeShape} className={labelClass}>
          {t("settings.knowledge.treeShape.label")}
        </Label>
        <select
          id={knowledgeControlDomIds.treeShape}
          className={selectClass}
          value={controls.treeShape}
          aria-describedby={`${knowledgeControlDomIds.treeShape}-help`}
          onChange={(event) => onEdit({ treeShape: event.target.value as TreeShape })}
        >
          {TreeShapeSchema.options.map((shape) => (
            <option key={shape} value={shape}>
              {t(treeShapeCopy[shape].option)}
            </option>
          ))}
        </select>
      </div>
      <div id={`${knowledgeControlDomIds.treeShape}-help`} className="-mt-3 grid gap-1">
        <p className="text-xs leading-5 text-muted-foreground">
          {t(treeShapeCopy[controls.treeShape].help)}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {t("settings.knowledge.treeShape.note")}
        </p>
      </div>

      <SwitchRow
        id={knowledgeControlDomIds.onlyIdle}
        label={t("settings.knowledge.onlyIdle.label")}
        hint={t("settings.knowledge.onlyIdle.hint")}
        checked={controls.onlyIdle}
        onChange={(onlyIdle) => onEdit({ onlyIdle })}
      />
      <SwitchRow
        id={knowledgeControlDomIds.onlyOnAc}
        label={t("settings.knowledge.onlyOnAc.label")}
        hint={t("settings.knowledge.onlyOnAc.hint")}
        checked={controls.onlyOnAc}
        onChange={(onlyOnAc) => onEdit({ onlyOnAc })}
      />

      <SaveStatus t={t} state={state} />
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id} className={labelClass}>
          {label}
        </Label>
        <p id={`${id}-hint`} className="mt-1 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}

/** The cap in dollars: typed, committed on blur or Enter, cancelled with Escape. */
function MonthlyCapField({
  t,
  value,
  spend,
  onCommit
}: {
  t: Translator;
  value: number;
  spend: BudgetSnapshot["money"] | null;
  onCommit: (value: number) => void;
}) {
  const id = knowledgeControlDomIds.monthlyCapUsd;
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  // A saved or restored cap replaces the text being edited.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(String(value));
    setInvalid(false);
  }
  const money = (amount: number) =>
    new Intl.NumberFormat(t.locale, { style: "currency", currency: "USD" }).format(amount);
  const commit = () => {
    const parsed = parseMonthlyCapInput(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <div className="grid gap-1 md:max-w-sm">
      <Label htmlFor={id} className={labelClass}>
        {t("settings.knowledge.cap.label")}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        max={monthlyCapMaxUsd}
        step={0.5}
        value={draft}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(String(value));
            setInvalid(false);
          }
        }}
      />
      {invalid ? (
        <p role="alert" className="text-xs text-danger">
          {t("settings.knowledge.cap.invalid", { values: { max: money(monthlyCapMaxUsd) } })}
        </p>
      ) : null}
      <p id={`${id}-hint`} className="text-xs leading-5 text-muted-foreground">
        {t("settings.knowledge.cap.hint")}
      </p>
      {spend ? (
        <p className="text-xs leading-5 text-secondary-foreground">
          {t("settings.knowledge.cap.spent", {
            values: { spent: money(spend.spentUsd), cap: money(spend.capUsd) }
          })}
        </p>
      ) : null}
      {spend && spend.state !== "open" ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-warning">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {t(
            spend.state === "paused"
              ? "settings.knowledge.cap.state.paused"
              : "settings.knowledge.cap.state.exhausted"
          )}
        </p>
      ) : null}
    </div>
  );
}

/** One live region for the save: saving, saved, or the failure that put the old value back. */
function SaveStatus({
  t,
  state
}: {
  t: Translator;
  state: Extract<KnowledgeControlsState, { phase: "ready" }>;
}) {
  if (state.outcome === "failed")
    return (
      <p role="alert" className="flex items-center gap-2 text-sm text-danger">
        <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
        {t("settings.knowledge.states.saveFailed")}
      </p>
    );
  return (
    <p role="status" className="flex min-h-5 items-center gap-2 text-xs text-secondary-foreground">
      {state.saving > 0 ? (
        <>
          <LoaderCircle
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("settings.knowledge.states.saving")}
        </>
      ) : state.outcome === "saved" ? (
        <>
          <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
          {t("settings.knowledge.states.saved")}
        </>
      ) : null}
    </p>
  );
}

/** Reads the controls, saves each change in the order it was made and follows the month's spend. */
export function KnowledgeControlsPanel({ t }: { t: Translator }) {
  const [state, dispatch] = useReducer(knowledgeControlsReducer, initialKnowledgeControlsState);
  const [spend, setSpend] = useState<BudgetSnapshot["money"] | null>(null);
  // Changes are saved in the order they were made, whichever render made them.
  const [save] = useState(() =>
    createKnowledgeControlsSaver((change) => window.app.knowledgeControls.update(change), dispatch)
  );
  const loading = state.phase === "loading";
  useEffect(() => {
    if (!loading) return;
    let active = true;
    void readKnowledgeControls(() => window.app.knowledgeControls.get()).then((action) => {
      if (active) dispatch(action);
    });
    return () => {
      active = false;
    };
  }, [loading]);
  useEffect(() => {
    let active = true;
    // The spend line is a help, not a control: when it cannot be read it is left out.
    void window.app.budget
      .snapshot()
      .then((snapshot) => {
        if (active) setSpend(snapshot.money);
      })
      .catch(() => undefined);
    const stop = window.app.onAppEvent("budget.changed", (event) => {
      if (active) setSpend(event.budget.money);
    });
    return () => {
      active = false;
      stop();
    };
  }, []);
  return (
    <KnowledgeControlsView
      t={t}
      state={state}
      spend={spend}
      onEdit={(change) => void save(change)}
      onRetry={() => dispatch({ type: "retry" })}
    />
  );
}
