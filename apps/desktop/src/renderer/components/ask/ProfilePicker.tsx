import { useState } from "react";
import type { Translator } from "@app/i18n";
import type { AiProfile } from "../../../shared/ipc";
import { Switch } from "../ui/switch";
const control =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900";
export function ProfilePicker({
  profiles,
  value,
  onChange,
  t
}: {
  profiles: AiProfile[];
  value: string;
  onChange: (s: string) => void;
  t: Translator;
}) {
  const [override, setOverride] = useState(Boolean(value));
  const available = profiles.filter(
    (p) => p.status === "active" && p.capabilities.includes("structured-output")
  );
  return (
    <div className="grid min-w-0 gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          role="switch"
          checked={override}
          onChange={(e) => {
            setOverride(e.target.checked);
            if (!e.target.checked) onChange("");
          }}
        />
        {t("organization.forceModel")}
      </label>
      {override ? (
        <label className="grid min-w-0 gap-1 text-sm">
          {t("settings.ai.model")}
          <select
            className={control + " min-w-0 w-full"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{t("organization.defaultModel")}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.modelId}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-xs leading-5 text-slate-500">{t("organization.routerHint")}</p>
      )}
      {!available.length && (
        <p role="status" className="text-sm text-amber-600">
          {t("organization.noModel")}
        </p>
      )}
    </div>
  );
}
