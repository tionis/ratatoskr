/**
 * Standalone migration script.
 * Run with: bun run db:migrate
 */

import { config } from "../config.ts";
import { initDatabase } from "./database.ts";

async function main() {
  console.log("Running database migrations...");
  console.log(`Data directory: ${config.dataDir}`);

  await initDatabase(config.dataDir);

  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
