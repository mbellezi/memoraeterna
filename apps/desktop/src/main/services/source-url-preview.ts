import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SourceUrlPreviewError =
  | "errors.ingestion.urlInvalid"
  | "errors.ingestion.urlUnsafe"
  | "errors.ingestion.urlTooManyRedirects"
  | "errors.ingestion.urlAccessDenied"
  | "errors.ingestion.urlNotFound"
  | "errors.ingestion.urlUnsupportedContent"
  | "errors.ingestion.urlTooLarge"
  | "errors.ingestion.urlTimeout"
  | "errors.ingestion.urlFetchFailed";

export type ExternalPageFetch = (url: string, init: RequestInit) => Promise<Response>;

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && !(a === 169 && b === 254) && !(a === 192 && [0, 168].includes(b!))
      && !(a === 172 && b! >= 16 && b! <= 31) && !(a === 100 && b! >= 64 && b! <= 127)
      && a! < 224 && !(a === 198 && (b === 18 || b === 19 || b === 51)) && !(a === 203 && b === 0);
  }
  // Only global unicast IPv6; mapped IPv4, loopback and private ranges are excluded.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^2002:/i.test(address) && !/^2001:(?:db8|0*0|0*2):/i.test(address);
}

export function youtubeIdFromUrl(value: string): string | null {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1)
    : ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)
      ? url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)$/)?.[1] : null;
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Pin DNS results to the HTTPS connection, and revalidate each redirect. */
export async function readPublicHtml(value: string, fetchExternalPage: ExternalPageFetch, redirects = 0): Promise<{ html: string; url: string }> {
  if (redirects > 3) throw new Error("errors.ingestion.urlTooManyRedirects");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("errors.ingestion.urlInvalid"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("errors.ingestion.urlInvalid");
  }
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(url.hostname, { all: true }); }
  catch { throw new Error("errors.ingestion.urlFetchFailed"); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("errors.ingestion.urlUnsafe");
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
    "User-Agent": chromeUserAgent()
  };
  let response: Response;
  try {
    response = await fetchExternalPage(url.toString(), {
      method: "GET", headers, redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(12_000)
    });
  } catch (error) {
    throw new Error(error instanceof Error && error.name === "AbortError"
      ? "errors.ingestion.urlTimeout"
      : error instanceof Error ? knownUrlError(error) : "errors.ingestion.urlFetchFailed");
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("errors.ingestion.urlFetchFailed");
    return readPublicHtml(new URL(location, url).toString(), fetchExternalPage, redirects + 1);
  }
  const responseError = sourceUrlResponseError(response.status, response.headers.get("content-type") ?? undefined);
  if (responseError) throw new Error(responseError);
  return { html: await readBoundedResponseBody(response), url: url.toString() };
}

export function sourceUrlResponseError(statusCode: number | undefined, contentType: string | undefined): SourceUrlPreviewError | null {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return "errors.ingestion.urlAccessDenied";
  if (statusCode === 404 || statusCode === 410) return "errors.ingestion.urlNotFound";
  if (statusCode !== 200) return "errors.ingestion.urlFetchFailed";
  if (!contentType?.toLowerCase().includes("text/html")) return "errors.ingestion.urlUnsupportedContent";
  return null;
}

export function chromeUserAgent(
  platform: NodeJS.Platform = process.platform,
  chromeVersion = process.versions.chrome ?? "140.0.0.0"
): string {
  const platformToken = platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 5 * 1024 * 1024) throw new Error("errors.ingestion.urlTooLarge");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 5 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("errors.ingestion.urlTooLarge");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

function knownUrlError(error: Error): SourceUrlPreviewError {
  return error.message.startsWith("errors.ingestion.")
    ? error.message as SourceUrlPreviewError
    : "errors.ingestion.urlFetchFailed";
}
