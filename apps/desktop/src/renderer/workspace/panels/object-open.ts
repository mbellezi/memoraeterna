import { formatObjectAddress } from "@app/domain";

import { citationTarget, type PassageAnchor } from "../../lib/object-navigation";
import type { OpenableNavigation } from "../../components/WhereIsThis";
import type { PanelLoadState } from "../PanelFrame";

/**
 * What the Note and Topic pages' links open in the stack (D8, D10): every target is an object
 * address pushed beside the panel; no click switches the destination. Pure, so it is tested without
 * a renderer.
 */

/** The address a page's navigation leads to: a source (the last of its path), a note or a topic. */
export function addressForNavigation(navigation: OpenableNavigation): string | null {
  switch (navigation.type) {
    case "topic":
      return formatObjectAddress({ kind: "topic", id: navigation.topicId });
    case "note":
      return formatObjectAddress({ kind: "note", id: navigation.noteId });
    case "source": {
      const id = navigation.path.at(-1);
      return id ? formatObjectAddress({ kind: "source", id }) : null;
    }
  }
}

/** A citation's passage opens the source highlighted: its address carries the passage's anchors. */
export function addressForPassage(sourceItemId: string, passage: PassageAnchor): string {
  return citationTarget({
    sourceItemId,
    chunkId: passage.chunkId,
    sourceSpanId: passage.sourceSpanId,
    documentId: passage.documentId
  }).address;
}

/** What a page's own read says, as the four states of a panel's frame. */
export function frameState(status: "loading" | "error" | "missing" | "ready"): PanelLoadState {
  if (status === "ready") return "success";
  if (status === "missing") return "empty";
  return status;
}
