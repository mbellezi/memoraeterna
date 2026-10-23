import { describe, expect, it } from "vitest";

import type { ModelDownloadEvent } from "../../shared/app-events";
import type { LocalModelView } from "../../shared/ipc";
import { applyModelDownloadEvent } from "./model-download-events";

const modelId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";

const view = (id: string, overrides: Partial<LocalModelView> = {}): LocalModelView =>
  ({
    id,
    catalogId: `catalog-${id.slice(-1)}`,
    status: "downloading",
    lastError: null,
    installedSizeBytes: 0,
    download: {
      jobId: "00000000-0000-4000-8000-0000000000aa",
      currentFile: "a.gguf",
      downloadedBytes: 10,
      totalBytes: 100,
      bytesPerSecond: 5,
      etaSeconds: 18
    },
    ...overrides
  }) as LocalModelView;

const event = (overrides: Partial<ModelDownloadEvent> = {}): ModelDownloadEvent => ({
  type: "model.download",
  localModelId: modelId,
  catalogId: "catalog-1",
  status: "downloading",
  currentFile: "b.gguf",
  downloadedBytes: 60,
  totalBytes: 100,
  bytesPerSecond: 9,
  etaSeconds: 4,
  error: null,
  ...overrides
});

describe("patching a model list from model.download events", () => {
  it("moves the progress of the model the event names and nothing else", () => {
    const models = [view(modelId), view(otherId)];

    const update = applyModelDownloadEvent(models, event());

    expect(update.reload).toBe(false);
    expect(update.models[0]?.download).toEqual({
      jobId: "00000000-0000-4000-8000-0000000000aa",
      currentFile: "b.gguf",
      downloadedBytes: 60,
      totalBytes: 100,
      bytesPerSecond: 9,
      etaSeconds: 4
    });
    expect(update.models[1]).toBe(models[1]);
  });

  it("follows verifying without reading the list", () => {
    const update = applyModelDownloadEvent(
      [view(modelId)],
      event({ status: "verifying", currentFile: null, downloadedBytes: 100, etaSeconds: null })
    );

    expect(update.models[0]?.status).toBe("verifying");
    expect(update.reload).toBe(false);
  });

  it("asks for a read when the install settled, and shows the failure meanwhile", () => {
    const ready = applyModelDownloadEvent([view(modelId)], event({ status: "ready" }));
    const failed = applyModelDownloadEvent(
      [view(modelId)],
      event({ status: "failed", error: "errors.localModels.checksumMismatch" })
    );

    expect(ready).toMatchObject({ reload: true, models: [{ status: "ready" }] });
    expect(failed.reload).toBe(true);
    expect(failed.models[0]).toMatchObject({
      status: "failed",
      lastError: "errors.localModels.checksumMismatch"
    });
  });

  it("asks for a read for a model the list does not hold", () => {
    const update = applyModelDownloadEvent([view(otherId)], event());

    expect(update.reload).toBe(true);
    expect(update.models[0]).toEqual(view(otherId));
  });

  it("asks for a read when an install the owner did not click started, so the row has no download yet", () => {
    const update = applyModelDownloadEvent(
      [view(modelId, { status: "not_downloaded", download: null })],
      event()
    );

    expect(update.reload).toBe(true);
    expect(update.models[0]).toMatchObject({ status: "downloading", download: null });
  });
});
