import { remoteGenerationContextWindow } from "@app/domain";
import type { JsonObject } from "@app/db";

export const profileGenerationMaxTokens = 16_384;

export function withAiTaskParameterDefaults(
  taskType: string,
  parameters: JsonObject,
  localModel: boolean,
  options: { admitted?: boolean; contextWindowLimit?: number | null } = {}
): JsonObject {
  if (taskType === "embedding") {
    return { dimensions: 768, ...parameters };
  }
  const known=options.contextWindowLimit;
  const requested=typeof parameters.contextWindow==='number'?parameters.contextWindow:options.admitted?null:remoteGenerationContextWindow;
  if(!localModel&&options.admitted&&known&&(requested??8192)>known)throw new Error("errors.ai.contextWindowLimit");
  const effective=!localModel&&requested!==null?Math.min(requested,known??2_000_000):null;
  return {
    maxTokens: profileGenerationMaxTokens,
    ...(localModel && taskType === "atomic-note-generation" ? { temperature: 0 } : {}),
    ...parameters,
    ...(effective!==null?{contextWindow:effective}:{})
  };
}

/** Only explicit discovered limits are capacity evidence; model names do not imply a window. */
export function discoveredContextWindow(metadata: Record<string, unknown> | null | undefined): number | null {
  const limits=metadata?.modelLimits;
  if(!limits||typeof limits!=='object'||Array.isArray(limits))return null;
  const values=['contextWindow','inputTokens'].map(key=>(limits as Record<string,unknown>)[key]).filter((value):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=128&&value<=2_000_000);
  return values.length?Math.min(...values):null;
}
export function discoveredModelLimits(limits: Record<string, unknown>): JsonObject {
  return Object.fromEntries(['contextWindow','inputTokens','outputTokens'].flatMap(key=>{const value=limits[key];return typeof value==='number'&&Number.isInteger(value)&&value>=1&&value<=2_000_000?[[key,value]]:[];}));
}

/** Conservative planning/reservation bound, not reported token usage or a provider tokenizer. */
export function estimateAiPlanningTokens(input:string,adapterInstruction:string,outputTokens:number):number {
  return Buffer.byteLength(input,'utf8')+Buffer.byteLength(adapterInstruction,'utf8')+outputTokens+1024;
}

export function organizationAiFailure(error:unknown,fallback='organization.errors.failed'):string {
  return String(error).includes('errors.ai.contextWindowLimit')?'organization.errors.context':String(error).match(/(?:organization|maintenance)\.errors\.[A-Za-z]+/)?.[0]??fallback;
}
