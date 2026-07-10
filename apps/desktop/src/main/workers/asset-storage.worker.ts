import { createHash } from "node:crypto";

export async function runAssetStorage(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof payload.dataBase64 !== "string") throw new Error("Asset worker requires dataBase64.");
  const data = Buffer.from(payload.dataBase64, "base64");
  return { sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.byteLength };
}
