import type { Dispatch } from "react";
import { formatObjectAddress, parseObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { TopicNavigator } from "../../../components/topics/TopicNavigator";
import { usePinShortcut } from "../../pin-object";
import type { WorkspaceAction, WorkspaceState } from "../../state";

/**
 * Explore's navigator (design record 5.3): the topic tree hosted in the navigator column. A click
 * on a topic, a note or a source opens it beside the focused panel of Explore's stack and never
 * leaves Explore; the tree follows the top panel when it is a topic; "Show only this branch"
 * hoists the tree to a topic, and the breadcrumb at its top brings the whole tree back.
 */

/** The topic the top panel of Explore shows, which the tree follows; null for another kind. */
export function followedTopic(workspace: WorkspaceState): string | null {
  const stack = workspace.stacks.explore;
  const panel = stack.panels[stack.focus];
  const address = panel?.history[panel.index];
  const parsed = address ? parseObjectAddress(address) : null;
  return parsed?.kind === "topic" ? parsed.id : null;
}

/** The hoist the "Show only this branch" command applies: the topic in the top panel, else none. */
export function hoistAction(workspace: WorkspaceState): WorkspaceAction | null {
  const topicId = followedTopic(workspace);
  return topicId === null ? null : { type: "hoist", topicId };
}

export interface ExploreNavigatorProps {
  t: Translator;
  workspace: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
}

export function ExploreNavigator({ t, workspace, dispatch }: ExploreNavigatorProps) {
  usePinShortcut(workspace);
  const openBeside = (address: string) =>
    dispatch({
      type: "open",
      address,
      from: workspace.stacks.explore.focus,
      mode: "push"
    });
  return (
    <TopicNavigator
      t={t}
      active
      selectedTopicId={followedTopic(workspace)}
      hoistId={workspace.hoist}
      onExitHoist={() => dispatch({ type: "hoist", topicId: null })}
      onOpenTopic={(id) => openBeside(formatObjectAddress({ kind: "topic", id }))}
      onOpenSource={(sourceItemId, atomicNoteId) =>
        openBeside(
          atomicNoteId
            ? formatObjectAddress({ kind: "note", id: atomicNoteId })
            : formatObjectAddress({ kind: "source", id: sourceItemId })
        )
      }
    />
  );
}
