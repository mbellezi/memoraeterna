import { randomUUID } from "./uuid.js";

import {
  captureSelectionRequestSchema,
  captureWebPageRequestSchema,
  captureYouTubeVideoRequestSchema,
  type CaptureSelectionRequest,
  type CaptureWebPageRequest,
  type CaptureYouTubeVideoRequest
} from "@app/integration-contracts";

export interface ExtractedPage {
  url: string;
  title: string;
  html: string;
  textContent: string;
  selection: string;
  surroundingText?: string;
  metadata: Record<string, unknown>;
}

export function parseYouTubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return validVideoId(url.pathname.split("/")[1]);
    if (!["youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return null;
    if (url.pathname === "/watch") return validVideoId(url.searchParams.get("v"));
    const match = /^\/(?:shorts|embed|live)\/([^/?]+)/.exec(url.pathname);
    return validVideoId(match?.[1]);
  } catch {
    return null;
  }
}

export function createWebCapture(page: ExtractedPage): CaptureWebPageRequest {
  return captureWebPageRequestSchema.parse({
    requestId: randomUUID(),
    url: page.url,
    title: page.title || page.url,
    capturedAt: new Date().toISOString(),
    html: page.html,
    textContent: page.textContent,
    metadata: page.metadata
  });
}

export function createSelectionCapture(page: ExtractedPage): CaptureSelectionRequest {
  return captureSelectionRequestSchema.parse({
    requestId: randomUUID(),
    url: page.url,
    title: page.title || page.url,
    capturedAt: new Date().toISOString(),
    selection: page.selection,
    ...(page.surroundingText ? { surroundingText: page.surroundingText } : {}),
    metadata: page.metadata
  });
}

export function createYouTubeCapture(page: ExtractedPage, videoId: string): CaptureYouTubeVideoRequest {
  return captureYouTubeVideoRequestSchema.parse({
    requestId: randomUUID(),
    url: page.url,
    videoId,
    title: page.title || undefined,
    capturedAt: new Date().toISOString(),
    visibleMetadata: page.metadata
  });
}

function validVideoId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;
}
