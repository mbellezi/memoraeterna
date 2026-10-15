import { useState } from "react";
import { Layers, MessageCircle, X } from "lucide-react";
import type { Translator } from "@app/i18n";
import { Button } from "../ui/button";

export interface WikiPlaceholderViewProps {
  t: Translator;
  /** Shown above the message when the Wiki was opened by a link to a page that no longer exists. */
  notice: boolean;
  onAsk: () => void;
  onDismissNotice: () => void;
  onOpenLibrary: () => void;
}

/**
 * What the reading surface of the Wiki shows while no topic is open: where to start, and the way to
 * the Library and to Ask. The navigator beside it holds the tree; the Ask dialog is the Wiki's.
 */
export function WikiPlaceholderView({
  t,
  notice,
  onAsk,
  onDismissNotice,
  onOpenLibrary
}: WikiPlaceholderViewProps) {
  return (
    <section
      aria-labelledby="wiki-placeholder-title"
      className="mx-auto grid w-full max-w-xl justify-items-start gap-4 py-12"
    >
      {notice ? (
        <div
          role="status"
          className="flex w-full items-center gap-3 rounded-lg border border-border-strong bg-info-soft p-3 text-sm text-foreground"
        >
          <p className="min-w-0 flex-1">{t("topics.placeholder.notice")}</p>
          <Button
            variant="ghost"
            className="shrink-0"
            aria-label={t("topics.placeholder.dismiss")}
            title={t("topics.placeholder.dismiss")}
            onClick={onDismissNotice}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      <Layers className="h-6 w-6 text-accent" aria-hidden="true" />
      <h2 id="wiki-placeholder-title" className="text-xl font-semibold text-foreground">
        {t("topics.placeholder.title")}
      </h2>
      <p className="text-sm leading-6 text-secondary-foreground">{t("topics.placeholder.body")}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onOpenLibrary}>
          {t("topics.placeholder.openLibrary")}
        </Button>
        <Button aria-haspopup="dialog" onClick={onAsk}>
          <MessageCircle aria-hidden="true" />
          {t("topics.placeholder.ask")}
        </Button>
      </div>
    </section>
  );
}

export interface WikiPlaceholderProps {
  t: Translator;
  active: boolean;
  /** Changes each time an old link or call asks for a wiki page; null when none did. */
  noticeToken: number | null;
  onOpenLibrary: () => void;
  onAsk: () => void;
}

/** The reading surface without an open topic; see {@link WikiPlaceholderView}. */
export function WikiPlaceholder({
  t,
  active,
  noticeToken,
  onOpenLibrary,
  onAsk
}: WikiPlaceholderProps) {
  const [seenToken, setSeenToken] = useState<number | null>(null);
  // A notice belongs to one visit: dismissing it, or leaving the Wiki, uses it up.
  if (!active && noticeToken !== null && seenToken !== noticeToken) setSeenToken(noticeToken);
  return (
    <WikiPlaceholderView
      t={t}
      notice={noticeToken !== null && noticeToken !== seenToken}
      onAsk={onAsk}
      onDismissNotice={() => setSeenToken(noticeToken)}
      onOpenLibrary={onOpenLibrary}
    />
  );
}
