export interface YouTubeCaptureResult {
  title: string;
  markdown: string;
  language: string;
  metadata: Record<string, unknown>;
}

interface YouTubeInfoLike {
  basic_info?: Record<string, unknown>;
  getTranscript?: () => Promise<unknown>;
}

export type YouTubeInfoLoader = (videoId: string) => Promise<YouTubeInfoLike>;

export class YouTubeService {
  public constructor(private readonly loadInfo: YouTubeInfoLoader = loadYoutubeInfo) {}

  public async capture(videoId: string, fallbackTitle?: string): Promise<YouTubeCaptureResult> {
    const info = await this.loadInfo(videoId);
    const basic = info.basic_info ?? {};
    const title = readString(basic.title) ?? fallbackTitle ?? videoId;
    const channel = basic.channel;
    const author = readString(basic.author) ?? readString(
      channel && typeof channel === "object" ? (channel as Record<string, unknown>).name : undefined
    );
    const durationSeconds = readNumber(basic.duration);
    const shortDescription = readString(basic.short_description);
    let transcriptSegments: string[] = [];
    let transcriptAvailable = false;
    if (info.getTranscript) {
      try {
        transcriptSegments = collectTranscriptText(await info.getTranscript());
        transcriptAvailable = transcriptSegments.length > 0;
      } catch {
        transcriptSegments = [];
      }
    }
    const sections = [
      `# ${title}`,
      author ? `**Channel:** ${author}` : "",
      shortDescription ? `## Description\n\n${shortDescription}` : "",
      transcriptAvailable ? `## Transcript\n\n${transcriptSegments.join("\n\n")}` : ""
    ].filter(Boolean);
    return {
      title,
      markdown: sections.join("\n\n"),
      language: "und",
      metadata: {
        videoId,
        ...(author ? { author } : {}),
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        transcriptAvailable,
        metadataEngine: "youtubei.js",
        metadataEngineVersion: "17.2.0"
      }
    };
  }
}

async function loadYoutubeInfo(videoId: string): Promise<YouTubeInfoLike> {
  const { Innertube } = await import("youtubei.js");
  const client = await Innertube.create({ generate_session_locally: true });
  return await client.getInfo(videoId) as unknown as YouTubeInfoLike;
}

function collectTranscriptText(value: unknown): string[] {
  const result: string[] = [];
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (current === null || current === undefined || seen.has(current)) return;
    if (typeof current === "string") return;
    if (typeof current !== "object") return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const record = current as Record<string, unknown>;
    const text = readString(record.text)
      ?? readString(record.snippet && typeof record.snippet === "object"
        ? (record.snippet as Record<string, unknown>).text
        : undefined);
    const start = readNumber(record.start_ms) ?? readNumber(record.startMs);
    if (text && (start !== undefined || "snippet" in record)) result.push(text.trim());
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return [...new Set(result.filter(Boolean))];
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "text" in value) {
    return readString((value as { text?: unknown }).text);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
