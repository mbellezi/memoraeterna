let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.inputPath.includes("crash")) process.exit(2);
if (request.inputPath.includes("timeout")) await new Promise((resolve) => setTimeout(resolve, 2_000));
if (request.inputPath.includes("output-limit")) process.stdout.write("x".repeat(1_024));
for (const event of [
  { stage: "loading_engine", progress: 0.05 },
  { stage: "processing_pages", progress: 0.5, completedPages: 2, totalPages: 4 },
  { stage: "serializing", progress: 0.95, completedPages: 4, totalPages: 4 }
]) {
  process.stdout.write(`${JSON.stringify({
    protocolVersion: 3,
    requestId: request.requestId,
    type: "progress",
    ...event
  })}\n`);
}
const markdown = "# Fake Docling\n";
process.stdout.write(`${JSON.stringify({
  protocolVersion: 3,
  requestId: request.requestId,
  ok: true,
  result: {
    status: "converted",
    markdown,
    contentHash: "a".repeat(64),
    blocks: [],
    assets: [],
    engine: "docling",
    engineVersion: "test",
    profile: request.profile,
    options: {},
    warnings: [],
    quality: { textCoverage: 1 },
    metadata: {}
  }
})}\n`);
