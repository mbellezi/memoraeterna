import { bumpAiConfigGeneration, type PgPool } from "@app/db";
import { presetCatalogIds } from "@app/domain";

import type { ModelDownloadEvent } from "../../../shared/app-events.js";
import type { WindowPorts } from "./soak-windows.js";

/**
 * The two DEV hooks of the soak's ground-truth windows (F4 T89, spec 5.4): a ranker whose
 * validation is invalidated (`no_model.no_decider`; placement takes decision 19's path), and an
 * embedder marked verifying with no network (`download.model_verifying`). Each changes what the
 * product reads of its local models and puts it back at the window's end. Neither runs a model.
 *
 * - The ranker's `reranking` capability exists only while its decide validation names the runtime
 *   build (`local-model-service.ts`): the hook takes the validation out of the model row and the
 *   capability out of the model row and of the profiles that serve it, exactly what the catalog sync
 *   does for a ranker with no valid validation, keeps what it took, writes it back at the end, and
 *   moves the AI configuration's generation so routes resolve again.
 * - The embedder's row is set to `verifying`, the status an install shows while its files are
 *   checked, and the `model.download` event of that state is published for the screens that follow it
 *   (the status service reads the same state); the end sets the row back and publishes it. Both move
 *   the AI configuration's generation, as every writer of a local model's row does: the AI service
 *   reads the row through its configuration cache, so without it the window's state reaches the
 *   service only if the cache happens to be empty, and its end not until another writer moves it
 *   (gate S 10-25: the embedder stayed unusable from 03:03 to 03:53, an import failed on it).
 *
 * What the status service reads for these two reasons is T86's; gate S checks that the sentence
 * follows these hooks, and this file is the place to change when it does not.
 */

export interface SoakHooksDeps {
  pool: PgPool;
  /** A packaged build never takes them: they write the AI configuration tables. */
  isPackaged: boolean;
  /** Publishes a `model.download` event (the app event bus); absent in tests. */
  publishModelDownload?: (event: ModelDownloadEvent) => void;
  logger?: Pick<Console, "info" | "error">;
}

interface RankerSnapshot {
  localModelId: string;
  catalogId: string;
  validation: unknown;
  capabilities: unknown;
  profiles: Array<{ id: string; capabilities: unknown }>;
}

interface EmbedderSnapshot {
  localModelId: string;
  catalogId: string;
  status: string;
  expectedSizeBytes: number;
}

export function createSoakHooks(options: SoakHooksDeps): WindowPorts["hooks"] {
  if (options.isPackaged) throw new Error("The soak's DEV hooks never run in a packaged build.");
  const deps = options;
  const { pool } = deps;
  let ranker: RankerSnapshot | null = null;
  let embedder: EmbedderSnapshot | null = null;

  const announce = (snapshot: EmbedderSnapshot, status: ModelDownloadEvent["status"]) => {
    deps.publishModelDownload?.({
      type: "model.download",
      localModelId: snapshot.localModelId,
      catalogId: snapshot.catalogId,
      status,
      currentFile: null,
      downloadedBytes: status === "ready" ? snapshot.expectedSizeBytes : 0,
      totalBytes: snapshot.expectedSizeBytes,
      bytesPerSecond: 0,
      etaSeconds: null,
      error: null
    });
  };

  return {
    async invalidateRanker() {
      if (ranker) return;
      const rows = await pool.query<{
        id: string;
        catalogId: string;
        validation: unknown;
        capabilities: unknown;
      }>(
        `select id::text as id, catalog_id as "catalogId",
                metadata -> 'decideValidation' as validation, capabilities
           from local_models
          where catalog_id = any($1::text[]) and status = 'ready' and capabilities ? 'reranking'
          order by (catalog_id = $2) desc limit 1`,
        [[presetCatalogIds.rankerMlx, presetCatalogIds.rankerGguf], presetCatalogIds.rankerMlx]
      );
      const model = rows.rows[0];
      if (!model) throw new Error("no validated ranker is installed in this profile");
      const profiles = await pool.query<{ id: string; capabilities: unknown }>(
        "select id::text as id, capabilities from ai_profile_sets where local_model_id = $1::uuid",
        [model.id]
      );
      ranker = {
        localModelId: model.id,
        catalogId: model.catalogId,
        validation: model.validation,
        capabilities: model.capabilities,
        profiles: profiles.rows
      };
      await pool.query(
        `update local_models
            set metadata = metadata - 'decideValidation',
                capabilities = capabilities - 'reranking', updated_at = now()
          where id = $1::uuid`,
        [model.id]
      );
      await pool.query(
        `update ai_profile_sets set capabilities = capabilities - 'reranking', updated_at = now()
          where local_model_id = $1::uuid`,
        [model.id]
      );
      bumpAiConfigGeneration();
      deps.logger?.info(`SOAK hook: the ranker ${model.catalogId} is invalidated`);
    },

    async restoreRanker() {
      const saved = ranker;
      if (!saved) return;
      ranker = null;
      await pool.query(
        `update local_models
            set metadata = case when $2::jsonb is null or $2::jsonb = 'null'::jsonb then metadata
                                else metadata || jsonb_build_object('decideValidation', $2::jsonb) end,
                capabilities = $3::jsonb, updated_at = now()
          where id = $1::uuid`,
        [
          saved.localModelId,
          JSON.stringify(saved.validation ?? null),
          JSON.stringify(saved.capabilities)
        ]
      );
      for (const profile of saved.profiles)
        await pool.query(
          "update ai_profile_sets set capabilities = $2::jsonb, updated_at = now() where id = $1::uuid",
          [profile.id, JSON.stringify(profile.capabilities)]
        );
      bumpAiConfigGeneration();
      deps.logger?.info(`SOAK hook: the ranker ${saved.catalogId} is restored`);
    },

    async markEmbedderVerifying() {
      if (embedder) return;
      const rows = await pool.query<{
        id: string;
        catalogId: string;
        status: string;
        expectedSizeBytes: number;
      }>(
        `select id::text as id, catalog_id as "catalogId", status,
                expected_size_bytes::float8 as "expectedSizeBytes"
           from local_models where catalog_id = $1`,
        [presetCatalogIds.embedding]
      );
      const model = rows.rows[0];
      if (!model) throw new Error("the local embedder is not in this profile");
      embedder = {
        localModelId: model.id,
        catalogId: model.catalogId,
        status: model.status,
        expectedSizeBytes: Number(model.expectedSizeBytes)
      };
      await pool.query(
        "update local_models set status = 'verifying', updated_at = now() where id = $1::uuid",
        [model.id]
      );
      bumpAiConfigGeneration();
      announce(embedder, "verifying");
      deps.logger?.info(`SOAK hook: the embedder ${model.catalogId} is marked verifying`);
    },

    async clearEmbedderVerifying() {
      const saved = embedder;
      if (!saved) return;
      embedder = null;
      await pool.query(
        "update local_models set status = $2, updated_at = now() where id = $1::uuid",
        [saved.localModelId, saved.status]
      );
      bumpAiConfigGeneration();
      announce(saved, saved.status as ModelDownloadEvent["status"]);
      deps.logger?.info(`SOAK hook: the embedder ${saved.catalogId} is back to ${saved.status}`);
    }
  };
}
