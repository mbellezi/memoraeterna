import type { ReactElement } from "react";
import { AtSign, CircleDot, Check, EqualApproximately, GitBranchPlus, GitCompareArrows, Lightbulb, Link2, Workflow } from "lucide-react";
import type { IconNode, LucideIcon } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

export const atomicRelationMessageKeys: Readonly<Record<string, MessageKey>> = {
  supports: "knowledge.relations.types.supports",
  contrasts: "knowledge.relations.types.contrasts",
  extends: "knowledge.relations.types.extends",
  similar_to: "knowledge.relations.types.similar_to",
  depends_on: "knowledge.relations.types.depends_on",
  clarifies: "knowledge.relations.types.clarifies",
  mentions: "knowledge.relations.types.mentions",
  related: "knowledge.relations.types.related"
};

export const atomicRelationLegend = [
  { type: "supports", color: "#34d399", icon: Check },
  { type: "contrasts", color: "#fb7185", icon: GitCompareArrows },
  { type: "extends", color: "#60a5fa", icon: GitBranchPlus },
  { type: "similar_to", color: "#c084fc", icon: EqualApproximately },
  { type: "depends_on", color: "#fbbf24", icon: Workflow },
  { type: "clarifies", color: "#facc15", icon: Lightbulb },
  { type: "mentions", color: "#22d3ee", icon: AtSign },
  { type: "related", color: "#a78bfa", icon: Link2 }
] as const;

export function atomicRelationColor(type: string | null): string {
  return atomicRelationLegend.find((item) => item.type === type)?.color ?? "#cbd5e1";
}

export const atomicRelationMarkerRadius = 8.8;

function extractLucideIconNode(icon: LucideIcon): IconNode {
  const element = (icon as unknown as {
    render: (props: Record<string, never>, ref: null) => ReactElement<{ iconNode: IconNode }>;
  }).render({}, null);
  return element.props.iconNode;
}

export function atomicRelationIconNode(type: string | null): IconNode {
  const icon = atomicRelationLegend.find((item) => item.type === type)?.icon ?? CircleDot;
  return extractLucideIconNode(icon);
}

export function atomicRelationIcon(type: string | null): LucideIcon {
  return atomicRelationLegend.find((item) => item.type === type)?.icon ?? CircleDot;
}

export function formatEdgeLabel(label: string, t: Translator): string {
  if (label === "shared_entity") return t("knowledgeGraph.edgeKinds.shared_entity");
  if (label === "semantic_relation") return t("knowledgeGraph.edgeKinds.semantic_relation");
  const atomicRelationKey = atomicRelationMessageKeys[label];
  if (atomicRelationKey) return t(atomicRelationKey);
  return label.replaceAll("_", " ");
}

