let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.inputPath.includes("crash")) process.exit(2);
if (request.inputPath.includes("timeout")) await new Promise((resolve) => setTimeout(resolve, 2_000));
if (request.inputPath.includes("output-limit")) process.stdout.write("x".repeat(1_024));
const markdown = "# Fake Docling\n";
process.stdout.write(`${JSON.stringify({
  protocolVersion: 1,
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
