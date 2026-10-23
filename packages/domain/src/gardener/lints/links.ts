// Redirect chains and broken `memora://` links (F4 D19 (2)). A retired topic redirects to its
// successor and `memora://topic/<id>` resolves through the redirects (T34b), so a chain
// A -> B -> C works but costs a hop on every link and keeps B alive as a stepping stone: AUDIT
// compresses it to A -> C through the engine. A link is broken when the object it names no longer
// exists, or a topic whose redirects never reach a live one. Pure: the topics and the persisted
// addresses (the recents and pins) come from the database or the engine's state.
import { parseObjectAddress } from "../../object-address.js";
import type { ObjectKind } from "../../object-address.js";
import { compareIds, findingAddress } from "./finding.js";
import type { LintFinding } from "./finding.js";

/** What the lint needs of a topic: whether it is retired and where it redirects. */
export interface RedirectNode {
  retired: boolean;
  redirectTo: string | null;
}

export type RedirectResolution =
  /** The redirects end at a live topic; `hops` redirects were followed (0: the topic is live). */
  | { kind: "live"; end: string; hops: number }
  /** A retired topic has no successor. */
  | { kind: "dead_end"; at: string; hops: number }
  | { kind: "cycle"; hops: number }
  /** A redirect names a topic that does not exist. */
  | { kind: "missing"; at: string; hops: number }
  /** The topic itself is unknown. */
  | { kind: "unknown" };

/** Follows the redirects of `id`, at most `maxHops` of them. */
export function resolveRedirect(
  nodes: ReadonlyMap<string, RedirectNode>,
  id: string,
  maxHops: number
): RedirectResolution {
  let current = nodes.get(id);
  if (!current) return { kind: "unknown" };
  let at = id;
  const seen = new Set<string>([id]);
  for (let hops = 0; ; hops += 1) {
    if (!current.retired) return { kind: "live", end: at, hops };
    if (current.redirectTo === null) return { kind: "dead_end", at, hops };
    if (hops >= maxHops || seen.has(current.redirectTo)) return { kind: "cycle", hops: hops + 1 };
    const next = nodes.get(current.redirectTo);
    if (!next) return { kind: "missing", at: current.redirectTo, hops: hops + 1 };
    seen.add(current.redirectTo);
    at = current.redirectTo;
    current = next;
  }
}

/** A retired topic whose redirect passes through other retired topics before a live one. */
export interface RedirectChain {
  topicId: string;
  /** Where it redirects now. */
  from: string;
  /** The live topic the chain ends at: where it should redirect. */
  to: string;
  /** Redirects followed (at least 2). */
  hops: number;
}

export interface RedirectUnresolved {
  topicId: string;
  reason: "cycle" | "missing";
  hops: number;
}

export interface RedirectReport {
  /** Chains to compress, by topic ID. */
  chains: RedirectChain[];
  /** Retired topics whose redirects reach no live topic and no dead end: corrupt, never fixed here. */
  unresolved: RedirectUnresolved[];
  /** Retired topics that redirect straight to a live one (the healthy case). */
  direct: number;
  /** Retired topics without a successor. */
  deadEnds: number;
}

/** Every retired topic of the map, classified. */
export function redirectReport(
  nodes: ReadonlyMap<string, RedirectNode>,
  maxHops: number
): RedirectReport {
  const report: RedirectReport = { chains: [], unresolved: [], direct: 0, deadEnds: 0 };
  const ids = [...nodes.keys()].sort(compareIds);
  for (const id of ids) {
    const node = nodes.get(id) as RedirectNode;
    if (!node.retired) continue;
    const resolution = resolveRedirect(nodes, id, maxHops);
    switch (resolution.kind) {
      case "live":
        if (resolution.hops >= 2 && node.redirectTo !== null) {
          report.chains.push({
            topicId: id,
            from: node.redirectTo,
            to: resolution.end,
            hops: resolution.hops
          });
        } else {
          report.direct += 1;
        }
        break;
      case "dead_end":
        report.deadEnds += 1;
        break;
      case "cycle":
      case "missing":
        report.unresolved.push({ topicId: id, reason: resolution.kind, hops: resolution.hops });
        break;
      case "unknown":
        break;
    }
  }
  return report;
}

/** The findings of redirects that cannot be fixed: the objects name the topic, the reason is a parameter. */
export function redirectFindings(report: RedirectReport): LintFinding[] {
  return report.unresolved.map((entry) => ({
    kind: "redirect_chain",
    fingerprint: `redirect:${entry.topicId}`,
    objectRefs: [findingAddress("topic", entry.topicId)],
    params: { reason: entry.reason, hops: entry.hops },
    risk: "medium"
  }));
}

// ---------------------------------------------------------------------------
// Persisted addresses

/** An address the app keeps (the recents and pins), and where it was kept. */
export interface PersistedAddress {
  address: string;
  /** `entry`: the address of an opened object; `parent`: the object that hosted the open. */
  role: "entry" | "parent";
}

/** How an address resolves now. `ok` includes a topic reached through redirects. */
export type AddressResolution = "ok" | "missing" | "no_successor" | "cycle";

export interface AddressTarget {
  address: string;
  kind: ObjectKind;
  id: string;
}

/** The distinct, well-formed addresses of a list, in address order; malformed ones are dropped. */
export function addressTargets(addresses: readonly PersistedAddress[]): AddressTarget[] {
  const targets = new Map<string, AddressTarget>();
  for (const { address } of addresses) {
    const parsed = parseObjectAddress(address);
    if (!parsed) continue;
    const canonical = findingAddress(parsed.kind, parsed.id);
    targets.set(canonical, { address: canonical, kind: parsed.kind, id: parsed.id });
  }
  return [...targets.values()].sort((a, b) => compareIds(a.address, b.address));
}

/** The resolution of a topic address, from the topics that exist. */
export function topicAddressResolution(
  nodes: ReadonlyMap<string, RedirectNode>,
  id: string,
  maxHops: number
): AddressResolution {
  const resolution = resolveRedirect(nodes, id, maxHops);
  switch (resolution.kind) {
    case "live":
      return "ok";
    case "dead_end":
      return "no_successor";
    case "cycle":
      return "cycle";
    case "missing":
    case "unknown":
      return "missing";
  }
}

/** The findings of the addresses that no longer resolve (`ok` ones have none). */
export function brokenLinkFindings(
  targets: readonly AddressTarget[],
  resolutions: ReadonlyMap<string, AddressResolution>
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const target of targets) {
    const resolution = resolutions.get(target.address) ?? "ok";
    if (resolution === "ok") continue;
    findings.push({
      kind: "broken_link",
      fingerprint: `link:${target.address}`,
      objectRefs: [target.address],
      params: { kind: target.kind, reason: resolution },
      risk: "low"
    });
  }
  return findings;
}
