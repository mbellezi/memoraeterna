// A tiny hand-written tree for the naming tests (T18): topics with notes that have a text, a
// language and a 3-d vector. Item keys and content hashes follow the notes' texts, so two worlds
// built from the same texts are the same content with different IDs when `idBase` differs.
// Not exported from the package.
import { createTopicTreeEditor } from "../events.js";
import { itemKey } from "../ids.js";
import type { ItemKey } from "../ids.js";
import type { FallbackText } from "../naming-fallback.js";
import { createTopicTreeState, placementRecord, registerItem } from "../state.js";
import type { TopicRecord, TopicTreeState } from "../state.js";
import { recomputeSubtree } from "../stats.js";
import { keyedVectors, unit } from "../vectors.js";
import type { ItemVectorSource } from "../vectors.js";
import { uuidOf } from "./placement-world.js";

export interface WorldNote {
  text: string;
  /** BCP 47 code of the note; default `en`. */
  language?: string;
  vector?: readonly [number, number, number];
  kind?: "note" | "source";
}

export interface WorldTopic {
  /** 1.. (0 is the root). */
  id: number;
  parent: number;
  fields?: Partial<Omit<TopicRecord, "id" | "parentId" | "role">>;
  notes?: WorldNote[];
}

export interface NamingWorld {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  texts: Map<ItemKey, FallbackText>;
  /** The topic ID of world topic `n`. */
  topic: (n: number) => string;
  /** Item keys of a topic's notes, in the order they were given. */
  itemsOf: (n: number) => ItemKey[];
  rootId: string;
}

/** The murmur3 finalizer: every input bit changes about half of the output bits. */
function mix32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A 64-hex content hash that depends on the text only and is well mixed, like a SHA-256. */
export function hashOfText(text: string): string {
  const out: string[] = [];
  for (let round = 0; round < 8; round += 1) {
    let h = 0x811c9dc5 ^ mix32(round + 1);
    for (let index = 0; index < text.length; index += 1) {
      h = Math.imul(h ^ text.charCodeAt(index), 0x01000193) >>> 0;
    }
    out.push(mix32(h).toString(16).padStart(8, "0"));
  }
  return out.join("");
}

export function namingWorld(topics: WorldTopic[], idBase = 0): NamingWorld {
  const rootId = uuidOf(idBase);
  const state = createTopicTreeState({ dim: 3, rootId });
  const editor = createTopicTreeEditor(state, { record: false });
  const texts = new Map<ItemKey, FallbackText>();
  const keys = new Map<string, ItemKey>();
  const itemKeysOf = new Map<number, ItemKey[]>();
  const rows: Array<[ItemKey, Float32Array]> = [];
  const topicId = (n: number): string => (n === 0 ? rootId : uuidOf(idBase + n));
  let noteNumber = 0;
  for (const topic of topics) {
    editor.createTopic(topicId(topic.id), topicId(topic.parent), {
      position: topic.id,
      ...topic.fields
    });
    const own: ItemKey[] = [];
    for (const note of topic.notes ?? []) {
      const kind = note.kind ?? "note";
      // Two worlds with the same texts get the same content hashes and different keys.
      const key = itemKey(kind, uuidOf(idBase + 1000 + (noteNumber += 1)));
      keys.set(note.text, key);
      registerItem(state, { key, kind, contentHash: hashOfText(note.text), rootSource: null });
      editor.placeItem(key, placementRecord(topicId(topic.id)));
      texts.set(key, { text: note.text, language: note.language ?? "en" });
      rows.push([key, unit(Float32Array.from(note.vector ?? [1, 0, 0]))]);
      own.push(key);
    }
    itemKeysOf.set(topic.id, own);
  }
  const matrix = {
    dim: 3,
    count: rows.length,
    data: Float32Array.from(rows.flatMap(([, vector]) => [...vector]))
  };
  const vectors = keyedVectors(
    matrix,
    rows.map(([key]) => key)
  );
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    texts,
    topic: topicId,
    itemsOf: (n) => itemKeysOf.get(n) ?? [],
    rootId
  };
}
