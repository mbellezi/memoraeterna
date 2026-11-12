import type { ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../components/ui/button";
import { Dialog, DialogContent } from "../../components/ui/dialog";

/**
 * The yes before something is deleted or switched on that cannot be taken back by one click: a
 * modal dialog that says what goes and what stays, with "Cancel" first in the tab order and the
 * action named by what it does ("Delete records"), never "OK". Esc and the scrim cancel it.
 */
export function ConfirmDialog({
  t,
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  danger = false,
  canConfirm = true,
  busy = false,
  portal = true,
  size = "md",
  children
}: {
  t: Translator;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  /** The action deletes something: the confirm button says so by its colour as well as its words. */
  danger?: boolean;
  canConfirm?: boolean;
  busy?: boolean;
  portal?: boolean;
  size?: "sm" | "md" | "lg";
  /** What the person fills in or reads before confirming. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        t={t}
        title={title}
        {...(description ? { description } : {})}
        size={size}
        portal={portal}
      >
        {children}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("shell.actions.cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={!canConfirm || busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
