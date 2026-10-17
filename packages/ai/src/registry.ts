import type { AiCapability } from "@app/domain";

import {
  createTaskHandle,
  hasCapabilities,
  type AiModelAdapter,
  type AiTaskHandle,
  type AiTaskRequest
} from "./contracts.js";

/** Wraps adapters as they are registered (the DEV-only AI cassette uses it). */
export type AiAdapterDecorator = (adapter: AiModelAdapter) => AiModelAdapter;

let adapterDecorator: AiAdapterDecorator | null = null;

/**
 * Installs a process-wide decorator applied to every adapter registered afterwards, so that every
 * routed AI execution passes through it; null removes it. Only DEV tooling installs one.
 */
export function setAiAdapterDecorator(decorator: AiAdapterDecorator | null): void {
  adapterDecorator = decorator;
}

export class AiModelRegistry {
  private readonly adapters = new Map<string, AiModelAdapter>();

  /**
   * Registers an adapter under `key` (default `providerId:modelId`) and returns the instance the
   * registry holds, which the DEV decorator may have wrapped. A caller that serves several
   * configurations of one provider and model keys by its configuration (`providerConfigId:modelId`),
   * so that two configurations never resolve each other's adapter (F3 D38).
   */
  public register(adapter: AiModelAdapter, key?: string): AiModelAdapter {
    const descriptor = adapter.describe();
    const held = adapterDecorator ? adapterDecorator(adapter) : adapter;
    this.adapters.set(key ?? `${descriptor.providerId}:${descriptor.modelId}`, held);
    return held;
  }

  public unregister(providerId: string, modelId: string): void {
    this.adapters.delete(`${providerId}:${modelId}`);
  }

  public unregisterKey(key: string): void {
    this.adapters.delete(key);
  }

  /** The adapter registered under `key`, when it declares what the call needs. */
  public get(key: string, required: readonly AiCapability[] = []): AiModelAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter || !hasCapabilities(adapter.describe(), required))
      throw new Error("errors.ai.noCompatibleModel");
    return adapter;
  }

  public list(required: readonly AiCapability[] = []): AiModelAdapter[] {
    return [...this.adapters.values()].filter((adapter) =>
      hasCapabilities(adapter.describe(), required)
    );
  }

  public resolve(input: {
    providerId?: string;
    modelId?: string;
    requiredCapabilities: readonly AiCapability[];
    offlineOnly?: boolean;
  }): AiModelAdapter {
    const adapter = this.list(input.requiredCapabilities).find((candidate) => {
      const descriptor = candidate.describe();
      return (
        (!input.providerId || descriptor.providerId === input.providerId) &&
        (!input.modelId || descriptor.modelId === input.modelId) &&
        (!input.offlineOnly || descriptor.capabilities.includes("offline"))
      );
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
