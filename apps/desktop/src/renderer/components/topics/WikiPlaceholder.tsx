import { useState } from "react";
import { BookOpen, MessageCircle, X } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { PassageAnchor } from "../../lib/object-navigation";
import { ConsultationDialog } from "../ConsultationDialog";
import { Button } from "../ui/button";

/** Ask here always starts on the whole library, with an empty question. */
const askStart = { page: null, initialQuestion: "" };

export interface WikiPlaceholderViewProps {
  t: Translator;
  /** Whether the Wiki is the view on screen. A hidden Wiki keeps no modal open. */
  active: boolean;
  /** Whether the Ask dialog is mounted; it loads when it mounts and not before. */
  askOpen: boolean;
  /** Shown above the message when the Wiki was opened by a link to a page that no longer exists. */
  notice: boolean;
  onAsk: () => void;
  onCloseAsk: () => void;
  onDismissNotice: () => void;
  onOpenLibrary: () => void;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}

/**
 * What the Wiki shows until the topic navigator replaces it: the old wiki is gone, the Library and
 * Ask are the way in. Nothing here loads; the Ask dialog does its own loading once it is opened.
 */
export function WikiPlaceholderView({
  t,
  active,
  askOpen,
  notice,
  onAsk,
  onCloseAsk,
  onDismissNotice,
  onOpenLibrary,
  onOpenSource
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
      <BookOpen className="h-6 w-6 text-accent" aria-hidden="true" />
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
      {askOpen ? (
        <ConsultationDialog
          {...askStart}
          t={t}
          active={active}
          onClose={onCloseAsk}
          onOpenSource={onOpenSource}
        />
      ) : null}
    </section>
  );
}

export interface WikiPlaceholderProps {
  t: Translator;
  active: boolean;
  /** Changes each time an old link or call asks for a wiki page; null when none did. */
  noticeToken: number | null;
  onOpenLibrary: () => void;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}

/** The Wiki screen of the interim empty state; see {@link WikiPlaceholderView}. */
export function WikiPlaceholder({
  t,
  active,
  noticeToken,
  onOpenLibrary,
  onOpenSource
}: WikiPlaceholderProps) {
  const [askOpen, setAskOpen] = useState(false);
  const [seenToken, setSeenToken] = useState<number | null>(null);
  // A notice belongs to one visit: dismissing it, or leaving the Wiki, uses it up.
  if (!active && noticeToken !== null && seenToken !== noticeToken) setSeenToken(noticeToken);
  return (
    <WikiPlaceholderView
      t={t}
      active={active}
      askOpen={askOpen}
      notice={noticeToken !== null && noticeToken !== seenToken}
      onAsk={() => setAskOpen(true)}
      onCloseAsk={() => setAskOpen(false)}
      onDismissNotice={() => setSeenToken(noticeToken)}
      onOpenLibrary={onOpenLibrary}
      onOpenSource={onOpenSource}
    />
  );
}
