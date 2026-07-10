import type { AiCapability } from "@app/domain";

import { createTaskHandle, hasCapabilities, type AiModelAdapter, type AiTaskHandle, type AiTaskRequest } from "./contracts.js";

export class AiModelRegistry {
  private readonly adapters = new Map<string, AiModelAdapter>();

  public register(adapter: AiModelAdapter): void {
    const descriptor = adapter.describe();
    this.adapters.set(`${descriptor.providerId}:${descriptor.modelId}`, adapter);
  }

  public unregister(providerId: string, modelId: string): void {
    this.adapters.delete(`${providerId}:${modelId}`);
  }

  public list(required: readonly AiCapability[] = []): AiModelAdapter[] {
    return [...this.adapters.values()].filter((adapter) => hasCapabilities(adapter.describe(), required));
  }

  public resolve(input: {
    providerId?: string;
    modelId?: string;
    requiredCapabilities: readonly AiCapability[];
    offlineOnly?: boolean;
  }): AiModelAdapter {
    const adapter = this.list(input.requiredCapabilities).find((candidate) => {
      const descriptor = candidate.describe();
      return (!input.providerId || descriptor.providerId === input.providerId)
        && (!input.modelId || descriptor.modelId === input.modelId)
        && (!input.offlineOnly || descriptor.capabilities.includes("offline"));
    });
    if (!adapter) throw new Error("errors.ai.noCompatibleModel");
    return adapter;
  }

  public run(
    request: AiTaskRequest,
    selection: { providerId?: string; modelId?: string; offlineOnly?: boolean } = {}
  ): AiTaskHandle {
    const adapter = this.resolve({
      ...selection,
      requiredCapabilities: request.requiredCapabilities
    });
    if (!adapter.canHandle(request)) throw new Error("errors.ai.unsupportedTask");
    return createTaskHandle(adapter, request);
  }
}
