import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../src/config.ts";

const backupRoot = process.argv[2] || "./backups";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = resolve(process.cwd(), backupRoot, `backup-${timestamp}`);
const dataDir = resolve(process.cwd(), config.dataDir);

console.log(`📂 Data directory: ${dataDir}`);
console.log(`📦 Creating backup at: ${backupDir}`);

// Ensure backup directory exists
mkdirSync(backupDir, { recursive: true });

// 1. Backup Database
const dbPath = join(dataDir, "ratatoskr.db");
const dbBackupPath = join(backupDir, "ratatoskr.db");

if (existsSync(dbPath)) {
  console.log("🔹 Backing up database (live snapshot)...");
  try {
    const db = new Database(dbPath);
    // VACUUM INTO creates a transactionally consistent copy of the DB
    db.exec(`VACUUM INTO '${dbBackupPath}'`);
    db.close();
    console.log("✅ Database backed up successfully.");
  } catch (err) {
    console.error("❌ Failed to backup database:", err);
    process.exit(1);
  }
} else {
  console.warn("⚠️ Database file not found, skipping DB backup.");
}

// 2. Backup Documents
const docsSrc = join(dataDir, "documents");
const docsDest = join(backupDir, "documents");

if (existsSync(docsSrc)) {
  console.log("🔹 Backing up document files...");
  try {
    cpSync(docsSrc, docsDest, { recursive: true });
    console.log("✅ Documents backed up successfully.");
  } catch (err) {
    console.error("❌ Failed to backup documents:", err);
    process.exit(1);
  }
} else {
  console.log("ℹ️ No documents directory found, skipping.");
}

console.log(`\n🎉 Backup completed successfully to ${backupDir}`);
