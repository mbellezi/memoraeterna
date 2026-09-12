import type { MessageKey, Translator } from "@app/i18n";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";

const roles = ["author", "editor", "translator", "organizer", "channel", "host", "contributor"] as const;
type CreatorRow = { name: string; affiliation: string; role: typeof roles[number] };
export function creatorRows(value: string): CreatorRow[] {
  return value.split("\n").map((line) => {
    const match = line.trim().match(/^([a-z]+):\s*(.*)$/i);
    const role = roles.find((item) => item === match?.[1]?.toLowerCase());
    const [name = "", affiliation = ""] = (role ? match![2]! : line).split("|", 2).map((part) => part.trim());
    return { name, affiliation, role: role ?? "author" };
  });
}
export function CreatorFields({ value, onChange, t }: { value: string; onChange: (value: string) => void; t: Translator }) {
  const [rows, setRows] = useState(() => creatorRows(value));
  const serialize = (items: CreatorRow[]) => items.map((row) => `${row.role}: ${row.name}${row.affiliation ? ` | ${row.affiliation}` : ""}`).join("\n");
  useEffect(() => { setRows((current) => serialize(current) === value ? current : creatorRows(value)); }, [value]);
  const save = (next: CreatorRow[]) => { setRows(next); onChange(serialize(next)); };
  return <fieldset className="grid min-w-0 gap-2"><legend className="mb-2 text-sm font-medium">{t("intake.creators")}</legend>{rows.map((row, index) => <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800"><div className="flex gap-2"><Input aria-label={t("intake.creatorName")} value={row.name} placeholder={t("intake.creatorName")} onChange={(event) => save(rows.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /><button type="button" aria-label={t("intake.removeCreator")} className="px-1 text-slate-500" onClick={() => save(rows.filter((_, i) => i !== index))}><X className="h-4 w-4" /></button></div><div className="grid gap-2"><select aria-label={t("intake.creatorRole")} value={row.role} className="min-w-0 rounded-md border border-slate-300 bg-white px-2 text-xs dark:border-slate-700 dark:bg-slate-950" onChange={(event) => save(rows.map((item, i) => i === index ? { ...item, role: event.target.value as CreatorRow["role"] } : item))}>{roles.map((role) => <option key={role} value={role}>{t(`intake.roles.${role}` as MessageKey)}</option>)}</select><details><summary className="cursor-pointer text-xs text-slate-500">{t("intake.affiliation")}</summary><Input className="mt-2" aria-label={t("intake.affiliation")} value={row.affiliation} onChange={(event) => save(rows.map((item, i) => i === index ? { ...item, affiliation: event.target.value } : item))} /></details></div></div>)}<Button type="button" onClick={() => save([...rows, { name: "", affiliation: "", role: "author" }])}><Plus className="h-3.5 w-3.5" />{t("intake.addCreator")}</Button></fieldset>;
}
