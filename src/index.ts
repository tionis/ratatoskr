import { runAdminCli } from "./cli-handlers.ts";
import { config } from "./config.ts";
import { createServer } from "./server.ts";
import { initDatabase } from "./storage/database.ts";
import { initRepo, shutdownRepo } from "./sync/repo.ts";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Initialize database (needed for both server and CLI)
  await initDatabase(config.dataDir);

  // Check if the command is a CLI command or server start
  // Known CLI categories: user, doc, blob, kv, help, --help, -h
  const cliCommands = ["user", "doc", "blob", "kv", "help", "--help", "-h"];

  if (!command || command === "server") {
    await runServer();
  } else if (cliCommands.includes(command)) {
    await runAdminCli(args);
    process.exit(0);
  } else {
    // If unknown command, show help
    console.error(`Unknown command: ${command}`);
    await runAdminCli(["help"]);
    process.exit(1);
  }
}

async function runServer() {
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
