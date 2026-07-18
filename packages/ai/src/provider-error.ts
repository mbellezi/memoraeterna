import { redactSensitiveText } from "./local-model-downloader.js";

export async function providerHttpError(
  response: Response,
  message = "AI provider request failed"
): Promise<Error> {
  let responseText = "";
  try {
    responseText = redactSensitiveText((await response.text()).trim());
  } catch {
    // The HTTP status remains useful when the response body cannot be read.
  }
  const summary = `${message} (${response.status}).`;
  return new Error(responseText.length > 0 ? `${summary}\n${responseText}` : summary);
}
