import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";

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
export async function readPublicHtml(value: string, redirects = 0): Promise<{ html: string; url: string }> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || redirects > 3) {
    throw new Error("errors.common.validationFailed");
  }
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("errors.common.validationFailed");
  const response = await new Promise<{ html?: string; redirect?: string }>((resolve, reject) => {
    const req = request(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "text/html", "User-Agent": "MemoraEterna/1.0" },
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); resolve({ redirect: new URL(res.headers.location, url).toString() }); return;
      }
      if (res.statusCode !== 200 || !res.headers["content-type"]?.includes("text/html")) {
        res.resume(); reject(new Error("errors.common.validationFailed")); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) { res.destroy(new Error("errors.common.validationFailed")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ html: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });
  return response.redirect ? readPublicHtml(response.redirect, redirects + 1) : { html: response.html!, url: url.toString() };
}
