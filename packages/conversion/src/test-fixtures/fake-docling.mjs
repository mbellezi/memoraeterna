import { createHash } from "node:crypto";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.inputPath.includes("crash")) process.exit(2);
if (request.inputPath.includes("timeout"))
  await new Promise((resolve) => setTimeout(resolve, 2_000));
if (request.inputPath.includes("output-limit")) process.stdout.write("x".repeat(1_024));
for (const event of [
  { stage: "loading_engine", progress: 0.05 },
  { stage: "processing_pages", progress: 0.5, completedPages: 2, totalPages: 4 },
  { stage: "serializing", progress: 0.95, completedPages: 4, totalPages: 4 }
]) {
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: 3,
      requestId: request.requestId,
      type: "progress",
      ...event
    })}\n`
  );
}
// Docling emits U+0000 for glyphs without a Unicode mapping, for example a math font's minus sign.
const nul = request.inputPath.includes("nul");
const formula = "Q = e \u0000 a";
const markdown = nul ? `# Title\n\n${formula}\n\nNext block\n` : "# Fake Docling\n";
const blocks = nul
  ? ["Title", formula, "Next block"].map((text, index) => {
      const markdownStart = markdown.indexOf(text);
      return {
        id: `#/texts/${index}`,
        type: "text",
        text,
        markdownStart,
        markdownEnd: markdownStart + text.length
      };
    })
  : [];
process.stdout.write(
  `${JSON.stringify({
    protocolVersion: 3,
    requestId: request.requestId,
    ok: true,
    result: {
      status: "converted",
      markdown,
      contentHash: nul ? createHash("sha256").update(markdown).digest("hex") : "a".repeat(64),
      blocks,
      assets: [],
      engine: "docling",
      engineVersion: "test",
      profile: request.profile,
      options: {},
      warnings: [],
      quality: { textCoverage: 1 },
      metadata: nul ? { title: "Fake\u0000 title" } : {},
      ...(nul
        ? { rawStructuredResult: { texts: blocks.map(({ text }) => ({ text, orig: text })) } }
        : {})
    }
  })}\n`
);
