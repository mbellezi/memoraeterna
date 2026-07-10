import { ConversionRouter } from "@app/conversion";

export async function runMarkdownConversion(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof payload.dataBase64 !== "string") throw new Error("Worker conversion payload is missing dataBase64.");
  const result = await new ConversionRouter().convert({
    data: Buffer.from(payload.dataBase64, "base64"),
    ...(typeof payload.fileName === "string" ? { fileName: payload.fileName } : {}),
    ...(typeof payload.mimeType === "string" ? { mimeType: payload.mimeType } : {}),
    ...(typeof payload.sourceUrl === "string" ? { sourceUrl: payload.sourceUrl } : {})
  });
  return result as unknown as Record<string, unknown>;
}
