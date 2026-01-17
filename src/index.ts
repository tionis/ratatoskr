import { config } from "./config.ts";
import { createServer } from "./server.ts";
import { initDatabase } from "./storage/database.ts";
import { initRepo, shutdownRepo } from "./sync/repo.ts";

async function main() {
  // Initialize database
  await initDatabase(config.dataDir);

  // Initialize automerge-repo
  initRepo();
  console.log("Automerge-repo initialized");

  // Create and start server
  const server = await createServer(config);

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    shutdownRepo();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`Ratatoskr listening on ${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
