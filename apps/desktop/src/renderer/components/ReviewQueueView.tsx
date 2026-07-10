import { useEffect, useState } from "react";
import { Check, Pencil, Trash2 } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { PendingAtomicNote } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function ReviewQueueView({ t }: { t: Translator }) {
  const [notes, setNotes] = useState<PendingAtomicNote[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function load() {
    setLoading(true);
    setError(false);
    try { setNotes(await window.app.knowledge.listPendingNotes()); }
    catch { setError(true); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function review(note: PendingAtomicNote, action: "approve" | "discard") {
    await window.app.knowledge.reviewNote({ id: note.id, action });
    await load();
  }

  function beginEdit(note: PendingAtomicNote) {
    setEditing(note.id);
    setTitle(note.title);
    setIdea(note.ideaStatement);
    setBody(note.bodyMarkdown);
  }

  async function saveEdit(note: PendingAtomicNote) {
    await window.app.knowledge.reviewNote({
      id: note.id,
      action: "edit",
      title,
      ideaStatement: idea,
      bodyMarkdown: body
    });
    setEditing(null);
    await load();
  }

  if (loading) return <QueueState>{t("shell.states.loading")}</QueueState>;
  if (error) return <QueueState>{t("knowledge.review.error")}</QueueState>;
  if (notes.length === 0) return <QueueState>{t("knowledge.review.empty")}</QueueState>;

  return <section className="grid gap-4">{notes.map((note) => <article key={note.id} className="grid gap-4 rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
    <div><p className="text-xs text-slate-500">{note.sourceTitle ?? t("knowledge.review.unknownSource")}</p><h2 className="font-semibold">{note.title}</h2></div>
    {editing === note.id ? <div className="grid gap-3">
      <div className="grid gap-1"><Label htmlFor={`title-${note.id}`}>{t("knowledge.review.fields.title")}</Label><Input id={`title-${note.id}`} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
      <div className="grid gap-1"><Label htmlFor={`idea-${note.id}`}>{t("knowledge.review.fields.idea")}</Label><Input id={`idea-${note.id}`} value={idea} onChange={(event) => setIdea(event.target.value)} /></div>
      <div className="grid gap-1"><Label htmlFor={`body-${note.id}`}>{t("knowledge.review.fields.body")}</Label><textarea id={`body-${note.id}`} value={body} onChange={(event) => setBody(event.target.value)} className="min-h-36 rounded-md border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950" /></div>
      <div className="flex justify-end gap-2"><Button type="button" onClick={() => setEditing(null)}>{t("shell.actions.cancel")}</Button><Button type="button" onClick={() => void saveEdit(note)}>{t("knowledge.review.actions.saveEdit")}</Button></div>
    </div> : <><p className="text-sm font-medium">{note.ideaStatement}</p><p className="whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{note.bodyMarkdown}</p><div className="flex flex-wrap justify-end gap-2"><Button type="button" onClick={() => void review(note, "approve")}><Check className="h-4 w-4" aria-hidden="true" />{t("knowledge.review.actions.approve")}</Button><Button type="button" onClick={() => beginEdit(note)}><Pencil className="h-4 w-4" aria-hidden="true" />{t("knowledge.review.actions.edit")}</Button><Button type="button" onClick={() => void review(note, "discard")}><Trash2 className="h-4 w-4" aria-hidden="true" />{t("knowledge.review.actions.discard")}</Button></div></>}
  </article>)}</section>;
}

function QueueState({ children }: { children: string }) {
  return <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">{children}</p>;
}
