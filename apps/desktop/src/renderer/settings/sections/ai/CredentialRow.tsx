import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { SettingRow } from "../../SettingRow";
import { AreaNotice, Field, StatusLine, TextField } from "./ai-parts";
import { useRowProps } from "./ai-rows";

/**
 * A credential that is one key or token: whether it is saved (never its value), a way to add or
 * replace it and, for the one that can be checked, a test. The secret is typed once into a password
 * field, sent to the main process and forgotten; taking it away is the row's own "Restore default",
 * which asks first. `extra` is what the credential's own story adds under its state (the Decisions
 * key says what OpenAI refused).
 */
export function CredentialRow({
  entry,
  saved,
  invalid = false,
  labels,
  hint,
  onSave,
  onTest,
  extra,
  notice,
  busy = false
}: {
  entry: SettingEntryV2;
  saved: boolean;
  /** The provider refused the saved secret. */
  invalid?: boolean;
  labels: {
    none: string;
    set: string;
    add: string;
    replace: string;
    field: string;
    invalid?: string;
    test?: string;
    testing?: string;
  };
  hint?: string;
  /** Saves the typed secret; answers whether it worked. */
  onSave: (secret: string) => Promise<boolean>;
  /** Checks the saved secret with its provider; the answer is a line to show. */
  onTest?: () => Promise<{ ok: boolean; text: string }>;
  extra?: ReactNode;
  notice?: string | undefined;
  busy?: boolean;
}) {
  const row = useRowProps(entry);
  const { t } = row;
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const test = async () => {
    if (!onTest) return;
    setTesting(true);
    setResult(null);
    try {
      setResult(await onTest());
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingRow
      {...row}
      stack={editing}
      defaultLabel={labels.none}
      control={
        editing ? undefined : (
          <>
            {saved && onTest ? (
              <Button disabled={testing || busy} onClick={() => void test()}>
                {testing ? labels.testing : labels.test}
              </Button>
            ) : null}
            <Button
              aria-label={`${saved ? labels.replace : labels.add}: ${row.label}`}
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {saved ? labels.replace : labels.add}
            </Button>
          </>
        )
      }
      note={
        <div className="grid gap-2">
          <StatusLine tone={invalid ? "warn" : saved ? "ok" : "idle"}>
            {invalid && labels.invalid ? labels.invalid : saved ? labels.set : labels.none}
          </StatusLine>
          {result ? (
            <StatusLine tone={result.ok ? "ok" : "warn"} live>
              {result.text}
            </StatusLine>
          ) : null}
          {extra}
          {editing ? (
            <SecretForm
              t={t}
              label={labels.field}
              hint={hint}
              onCancel={() => setEditing(false)}
              onSave={async (secret) => {
                const ok = await onSave(secret);
                if (ok) setEditing(false);
                return ok;
              }}
            />
          ) : null}
          <AreaNotice message={notice} />
        </div>
      }
    />
  );
}

function SecretForm({
  t,
  label,
  hint,
  onSave,
  onCancel
}: {
  t: Translator;
  label: string;
  hint: string | undefined;
  onSave: (secret: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const id = useId();
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!secret.trim()) return;
    setSaving(true);
    await onSave(secret.trim());
    setSaving(false);
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
      className="grid max-w-[30rem] gap-3 rounded-lg border border-border bg-soft p-3 text-sm"
    >
      <Field label={label} htmlFor={id} hint={hint}>
        <TextField
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving || !secret.trim()}>
          {saving ? t("settingsAi.providers.action.saving") : t("settingsAi.credential.save")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
