interface ExtractMessage { type: "extract-page"; }

chrome.runtime.onMessage.addListener((message: ExtractMessage, _sender, sendResponse) => {
  if (message.type !== "extract-page") return false;
  const selection = window.getSelection()?.toString().trim() ?? "";
  const active = window.getSelection()?.anchorNode?.parentElement?.textContent?.trim();
  const metadata: Record<string, unknown> = {
    description: readMeta("description"),
    author: readMeta("author"),
    published: readMeta("article:published_time"),
    language: document.documentElement.lang || undefined
  };
  sendResponse({
    url: location.href,
    title: document.title || location.href,
    html: document.documentElement.outerHTML.slice(0, 8_000_000),
    textContent: document.body?.innerText.slice(0, 2_000_000) ?? "",
    selection,
    surroundingText: active?.slice(0, 8_000),
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined))
  });
  return false;
});

function readMeta(name: string): string | undefined {
  return document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content || undefined;
}
