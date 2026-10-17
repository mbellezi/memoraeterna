/**
 * The pair lists of S1's second-library check (F3 R13): the panel labelled the nearest and the
 * second-nearest source pairs of the GOLD roots and of 20 CORP roots (`label-set.json`, sets
 * `source-neighbours`). This writes one basis of one library as a pairs file of the golden runner's
 * source pair verdict mode (`MEMORA_GOLDEN_SOURCE_PAIRS`), each pair by its two roots' exact titles
 * (from the label inputs' context export of that library) and labelled with its pair ID, so the v5
 * verdicts of the second-nearest pairs can be recorded live.
 *
 *   npx tsx scripts/golden/source-neighbour-pairs.ts --labels <label-set.json> \
 *     --context <env-g-context.json> --library golden --basis second-nearest --out <pairs.json>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

const labelSetSchema = z.object({
  items: z.array(
    z
      .object({
        pairId: z.string(),
        kind: z.string(),
        library: z.string(),
        loRoot: z.string().nullable().optional(),
        hiRoot: z.string().nullable().optional(),
        sets: z.array(
          z.object({ set: z.string(), basis: z.string().nullable().optional() }).passthrough()
        )
      })
      .passthrough()
  )
});
const contextSchema = z.object({
  roots: z.array(z.object({ id: z.string(), title: z.string() }).passthrough())
});

export type NeighbourBasis = "nearest" | "second-nearest";

export interface SourcePairEntry {
  left: string;
  right: string;
  label: string;
}

/** The labelled neighbour pairs of one library and basis, by root titles, in pair ID order. */
export function neighbourPairs(
  labelSet: z.infer<typeof labelSetSchema>,
  context: z.infer<typeof contextSchema>,
  library: string,
  basis: NeighbourBasis
): SourcePairEntry[] {
  const titles = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const root of context.roots) {
    titles.set(root.id, root.title);
    seen.set(root.title, (seen.get(root.title) ?? 0) + 1);
  }
  const title = (id: string | null | undefined, pairId: string) => {
    const found = id ? titles.get(id) : undefined;
    if (!found) throw new Error(`Pair ${pairId}: root ${String(id)} is not in the context export.`);
    if ((seen.get(found) ?? 0) > 1)
      throw new Error(`Pair ${pairId}: the title "${found}" names several roots.`);
    return found;
  };
  return labelSet.items
    .filter(
      (item) =>
        item.kind === "source" &&
        item.library === library &&
        item.sets.some((set) => set.set === "source-neighbours" && set.basis === basis)
    )
    .toSorted((a, b) => (a.pairId < b.pairId ? -1 : a.pairId > b.pairId ? 1 : 0))
    .map((item) => ({
      left: title(item.loRoot, item.pairId),
      right: title(item.hiRoot, item.pairId),
      label: item.pairId
    }));
}

export async function runSourceNeighbourPairs(argv: readonly string[]): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      labels: { type: "string" },
      context: { type: "string" },
      library: { type: "string" },
      basis: { type: "string" },
      out: { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });
  if (!values.labels || !values.context || !values.library || !values.out)
    throw new Error("--labels, --context, --library and --out are required.");
  const basis = (values.basis ?? "second-nearest") as NeighbourBasis;
  if (basis !== "nearest" && basis !== "second-nearest")
    throw new Error("--basis is nearest or second-nearest.");
  const read = async (path: string) => JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  const pairs = neighbourPairs(
    labelSetSchema.parse(await read(values.labels)),
    contextSchema.parse(await read(values.context)),
    values.library,
    basis
  );
  if (!pairs.length) throw new Error(`No ${basis} pairs of ${values.library} in the label set.`);
  const target = resolve(values.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(pairs, null, 2)}\n`);
  return `${pairs.length} ${basis} pairs of ${values.library} written to ${target}`;
}

if (import.meta.main) {
  try {
    console.info(await runSourceNeighbourPairs(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `[source-neighbour-pairs] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
