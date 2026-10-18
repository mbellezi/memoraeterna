import { chunkTexts, embedManyLimits } from "@app/ai";
import { createEmbeddingRepository, type PgPool } from "@app/db";

/** The space and model a set of vectors was made in. */
export interface EmbeddingIdentity {
  provider: string;
  model: string;
  runtime: string;
  spaceKey?: string;
}

/** The vectors of one batch of texts, in order, with the identity they were made in. */
export interface EmbeddingBatch extends EmbeddingIdentity {
  embeddings: number[][];
}

/**
 * Embeds a batch of texts; null when no embedding model is routed. The ingestion run and document
 * are absent for work that belongs to no run (the backfill of composite vectors), and `priority`
 * is `P3` for background work that always yields to ingestion (`P2`, the default).
 */
export type EmbeddingBatchGenerator = (
  texts: string[],
  signal: AbortSignal,
  context: {
    jobId: string;
    ingestionRunId?: string;
    sourceItemId: string;
    documentId?: string;
    stage: string;
    embeddingInputType: "document";
    chunkIds?: string[];
    priority?: "P2" | "P3";
  }
) => Promise<EmbeddingBatch | null>;

export interface EmbeddingStageInput {
  pool: PgPool;
  signal: AbortSignal;
  generate: EmbeddingBatchGenerator;
  /** The space key of the embedding route, known without a call; absent, no vector is reused. */
  routeSpaceKey?: () => Promise<string | null>;
  /** Validates a vector the way the embedding worker does and returns it as numbers. */
  validate: (embedding: number[]) => Promise<number[]>;
  /**
   * Whose call it is. Work that belongs to no ingestion run (a header chunk rebuilt after a late
   * summary) states none, and `P3` when it always yields to ingestion.
   */
  context: {
    jobId: string;
    ingestionRunId?: string;
    sourceItemId: string;
    documentId: string;
    priority?: "P2" | "P3";
  };
}

/** The configuration changed while a document was being embedded: the vectors would mix spaces. */
const configurationChanged = "errors.sourceRelations.configurationChanged";

function assertSameSpace(identity: EmbeddingIdentity | null, generated: EmbeddingIdentity): void {
  if (identity?.spaceKey && generated.spaceKey !== identity.spaceKey)
    throw new Error(configurationChanged);
}

function abortIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Ingestion canceled.", "AbortError");
}

export interface ChunkVectors {
  /** One vector per embedded or reused chunk, in the order of the chunks. */
  vectors: number[][];
  /** The identity of the last vectors, or of the reused ones when nothing was generated. */
  identity: EmbeddingIdentity | null;
  /** Chunks a model embedded in this run. */
  embedded: number;
  /** Chunks whose stored vector (same text, same space) was kept. */
  reused: number;
}

/**
 * Embeds the chunks of a document (F3 D37): the chunks whose stored vector was built from exactly
 * this text in the route's current space keep it, and the others are embedded in batches of at most
 * {@link embedManyLimits.perExecution}, each stored before the next batch, so a failure keeps what
 * the earlier batches stored and a retry skips it. Stops quietly when no embedding model is routed.
 */
export async function embedChunkVectors(
  input: EmbeddingStageInput & {
    chunks: ReadonlyArray<{ id: string; content: string; contentHash: string }>;
    /** Renders the text a chunk is embedded from. */
    render: (content: string) => string;
  }
): Promise<ChunkVectors> {
  const embeddings = createEmbeddingRepository(input.pool);
  const routeSpace = (await input.routeSpaceKey?.()) ?? null;
  const reusable = routeSpace
    ? await embeddings.findCurrentChunkVectors(
        input.chunks.map((chunk) => ({ id: chunk.id, contentHash: chunk.contentHash })),
        `native-v2:${routeSpace}`
      )
    : new Map();
  const byId = new Map<string, number[]>();
  let identity: EmbeddingIdentity | null = null;
  for (const chunk of input.chunks) {
    const stored = reusable.get(chunk.id);
    if (!stored) continue;
    byId.set(chunk.id, stored.embedding);
    identity = {
      provider: stored.provider,
      model: stored.model,
      runtime: stored.runtime,
      spaceKey: routeSpace!
    };
  }
  const reused = byId.size;
  const pending = input.chunks.filter((chunk) => !byId.has(chunk.id));
  let embedded = 0;
  for (const group of chunkTexts(pending, embedManyLimits.perExecution)) {
    abortIfCanceled(input.signal);
    const generated = await input.generate(
      group.map((chunk) => input.render(chunk.content)),
      input.signal,
      {
        ...input.context,
        stage: "embedding",
        chunkIds: group.map((chunk) => chunk.id),
        embeddingInputType: "document"
      }
    );
    if (!generated) break;
    assertSameSpace(identity, generated);
    for (const [index, chunk] of group.entries()) {
      const embedding = await input.validate(generated.embeddings[index] ?? []);
      await embeddings.upsert({
        targetType: "chunk",
        targetId: chunk.id,
        chunkId: chunk.id,
        provider: generated.provider,
        model: generated.model,
        runtime: generated.runtime,
        strategy: generated.spaceKey ? `native-v2:${generated.spaceKey}` : "native",
        contentHash: chunk.contentHash,
        embedding
      });
      byId.set(chunk.id, embedding);
      embedded += 1;
    }
    identity = generated;
  }
  return {
    vectors: input.chunks.flatMap((chunk) => {
      const vector = byId.get(chunk.id);
      return vector ? [vector] : [];
    }),
    identity,
    embedded,
    reused
  };
}

/**
 * Embeds the segments of a source's catalog header (not stored: they only feed the source's
 * composite vector). They go out in batches like the chunks do, in the space of `identity`.
 */
export async function embedHeaderVectors(
  input: EmbeddingStageInput & { segments: readonly string[]; identity: EmbeddingIdentity | null }
): Promise<{ vectors: number[][]; identity: EmbeddingIdentity | null }> {
  const vectors: number[][] = [];
  let identity = input.identity;
  for (const group of chunkTexts([...input.segments], embedManyLimits.perExecution)) {
    abortIfCanceled(input.signal);
    const generated = await input.generate(group, input.signal, {
      ...input.context,
      stage: "source_embedding",
      embeddingInputType: "document"
    });
    if (!generated) break;
    assertSameSpace(identity, generated);
    for (const [index] of group.entries())
      vectors.push(await input.validate(generated.embeddings[index] ?? []));
    identity = generated;
  }
  return { vectors, identity };
}
