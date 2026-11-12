import { useState, type ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { Dialog, DialogContent } from "../../../components/ui/dialog";

/**
 * The step before something that cannot be undone: a dialog that names what will happen and what
 * stays, with the destructive button last and Cancel first in reach (Esc and the scrim also cancel).
 * `onConfirm` answers `null` when it worked (the dialog closes) or the sentence that says what went
 * wrong (the dialog stays, with that sentence in place, so the person can try again or cancel). While
 * it runs nothing can be pressed twice.
 */
export function ConfirmDialog({
  t,
  open,
  onOpenChange,
  title,
  body,
  warn,
  confirmLabel,
  workingLabel,
  onConfirm,
  portal = true
}: {
  t: Translator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  /** The line that says it cannot be undone, in the dialog's body. */
  warn?: string;
  confirmLabel: string;
  workingLabel: string;
  onConfirm: () => Promise<string | null>;
  /** Tests and the screens tool render the content in place. */
  portal?: boolean;
}) {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = async () => {
    setWorking(true);
    setFailure(null);
    const result = await onConfirm();
    setWorking(false);
    if (result === null) onOpenChange(false);
    else setFailure(result);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (working) return;
        if (!next) setFailure(null);
        onOpenChange(next);
      }}
    >
      <DialogContent t={t} title={title} size="sm" portal={portal} description={body}>
        {warn ? <p className="m-0 text-sm font-semibold text-foreground">{warn}</p> : null}
        {failure ? (
          <p role="alert" className="m-0 text-sm text-danger">
            {failure}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={working} onClick={() => onOpenChange(false)}>
            {t("shell.actions.cancel")}
          </Button>
          <Button variant="danger" disabled={working} onClick={() => void confirm()}>
            {working ? workingLabel : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
