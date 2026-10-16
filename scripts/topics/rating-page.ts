// Owner blind rating (E4, F2 T30). Draws 30 topics from the three measurement profiles, serves a
// Portuguese page where the owner rates each one, and scores the answers against the D20 bar.
//
//   npm run topics:rating -- sample --env-c <dev-connection.json> --env-g <...> --env-f <...> --seed 20261016
//   npm run topics:rating -- serve seed-20261016
//   npm run topics:rating -- score seed-20261016
//
// Read-only: the profiles are opened with default_transaction_read_only. Nothing is sent anywhere:
// the page is served on 127.0.0.1 and the answers go to <run>/answers.json. Exit code 0 on success
// (score: the bar is met), 1 when the bar is not met, 2 on an error or incomplete answers.
import { parseRatingArgs, ratingUsage } from "./rating-args.js";
import { sampleRun, scoreRun, serveRun } from "./rating-commands.js";

const log = (line: string): void => console.error(`[topics:rating] ${line}`);

try {
  const command = parseRatingArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(ratingUsage);
  } else if (command.kind === "sample") {
    const { directory, manifest } = await sampleRun(command, log);
    console.info(
      `Sampled ${manifest.sampleSize} topics (seed ${manifest.seed}) into ${directory}\n` +
        `Next: npm run topics:rating -- serve ${manifest.run}`
    );
  } else if (command.kind === "serve") {
    const served = await serveRun(command.run, command.port);
    console.info(
      `Rating page: ${served.url}\n` +
        `Answers are saved as you go to ${served.answersPath}. Ctrl-C stops the server.`
    );
  } else {
    const { score, text, resultPath } = await scoreRun(command.run);
    console.info(text);
    log(`wrote ${resultPath}`);
    process.exitCode = score.passes === true ? 0 : score.passes === false ? 1 : 2;
  }
} catch (error) {
  // Driver errors can echo the connection string; report only a content-free summary.
  const message = error instanceof Error ? error.message : String(error);
  log(message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***"));
  console.error("Run with --help for usage.");
  process.exitCode = 2;
}
