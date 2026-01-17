import { config } from "./config.ts";
import { createServer } from "./server.ts";
import { initDatabase } from "./storage/database.ts";

async function main() {
  // Initialize database
  await initDatabase(config.dataDir);

  // Create and start server
  const server = await createServer(config);

  try {
    await server.listen({ port: config.port, host: config.host });
    console.log(`Ratatoskr listening on ${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
