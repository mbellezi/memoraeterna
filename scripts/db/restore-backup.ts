import {
  parseRestoreArgs,
  removeScratch,
  restoreBackup,
  restoreUsage,
  stopScratch
} from "./backup-restore.js";

// Usage: npx tsx scripts/db/restore-backup.ts --from <backup dir | .dump file> --name <slug> [--keep-running] [--force]
//        npx tsx scripts/db/restore-backup.ts --stop --name <slug>
//        npx tsx scripts/db/restore-backup.ts --remove --name <slug>
// Progress goes to stderr; the final result is one JSON document on stdout (no secrets).

try {
  const command = parseRestoreArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(restoreUsage);
  } else if (command.kind === "stop") {
    console.info(JSON.stringify(await stopScratch(command.slug), null, 2));
  } else if (command.kind === "remove") {
    console.info(JSON.stringify(await removeScratch(command.slug), null, 2));
  } else {
    console.info(JSON.stringify(await restoreBackup(command), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
