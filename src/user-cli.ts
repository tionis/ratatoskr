#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnyDocumentId,
  type DocHandle,
  Repo,
} from "@automerge/automerge-repo";
import { RatatoskrNetworkAdapter } from "./lib/cli-network-adapter.ts";

const CONFIG_PATH = join(homedir(), ".ratatoskr-cli.json");

const USAGE = {
  doc: `
Usage:
  ratatoskr-user doc <command> [args]

Commands:
  list              List documents
  get <id>          Get document metadata
  create [type]     Create a new document
  edit <id>         Edit document interactively
  watch <id>        Watch document changes live
  delete <id>       Delete a document
`,
  blob: `
Usage:
  ratatoskr-user blob <command> [args]

Commands:
  list                        List claimed blobs
  upload <file>               Upload a file
  download <hash> [outfile]   Download a blob
  delete <hash>               Release claim on blob
`,
};

function checkHelp(args: string[], usage: string) {
  if (args.includes("-h") || args.includes("--help") || args.includes("help")) {
    console.log(usage);
    process.exit(0);
  }
}

interface Config {
  url: string;
  token: string;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    return;
  }

  const [command, ...subArgs] = args;

  try {
    switch (command) {
      case "login":
        await handleLogin(subArgs);
        break;
      case "whoami":
        await handleWhoami();
        break;
      case "doc":
        await handleDoc(subArgs);
        break;
      case "blob":
        await handleBlob(subArgs);
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
Ratatoskr User CLI

Usage:
  ratatoskr-user <command> [args...]

Commands:
  login <url> <token>   Authenticate with the server
  whoami                Show current user info

  doc list              List documents
  doc get <id>          Get document metadata
  doc create [type]     Create a new document
  doc edit <id>         Edit document interactively
  doc watch <id>        Watch document changes live
  doc delete <id>       Delete a document

  blob list                        List claimed blobs
  blob upload <file>               Upload a file
  blob download <hash> [outfile]   Download a blob
  blob delete <hash>               Release claim on blob
`);
}

async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) {
    throw new Error("Not logged in. Run 'login <url> <token>' first.");
  }
  return await file.json();
}

async function saveConfig(config: Config) {
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`Configuration saved to ${CONFIG_PATH}`);
}

async function getRepo(config: Config): Promise<Repo> {
  const adapter = new RatatoskrNetworkAdapter({
    serverUrl: config.url,
    token: config.token,
    onAuthError: (msg) => {
      console.error("Auth error:", msg);
      process.exit(1);
    },
  });

  const repo = new Repo({
    network: [adapter],
  });

  // Wait for connection
  await adapter.whenReady();

  return repo;
}

// API Client
async function apiCall<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let config: Config;
  try {
    config = await loadConfig();
  } catch (e) {
    throw new Error("Not logged in. Run 'login <url> <token>' first.");
  }

  const baseUrl = config.url.endsWith("/")
    ? config.url.slice(0, -1)
    : config.url;
  const url = `${baseUrl}${path}`;

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${config.token}`);

  const response = await fetch(url, { ...options, headers });

  if (response.status === 204) {
    return null as T;
  }

  if (!response.ok) {
    let errorMsg = response.statusText;
    try {
      const error: any = await response.json();
      errorMsg = error.message || error.error || errorMsg;
    } catch {}
    throw new Error(`API Error (${response.status}): ${errorMsg}`);
  }

  // Check content type to decide how to parse
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }
  return response as unknown as T; // Return raw response for blobs
}

// Auth Handlers
async function handleLogin(args: string[]) {
  const [url, token] = args;
  if (!url || !token) {
    throw new Error("Usage: login <url> <token>");
  }

  // Validate credentials by fetching user info
  const testHeaders = new Headers();
  testHeaders.set("Authorization", `Bearer ${token}`);

  const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  const response = await fetch(`${baseUrl}/api/v1/auth/userinfo`, {
    headers: testHeaders,
  });

  if (!response.ok) {
    throw new Error("Failed to authenticate with provided credentials");
  }

  const user: any = await response.json();
  console.log(`Logged in as ${user.name || user.email || user.id}`);

  await saveConfig({ url, token });
}

async function handleWhoami() {
  const user = await apiCall("/api/v1/auth/userinfo");
  console.table([user]);
}

// Document Handlers
async function handleDoc(args: string[]) {
  checkHelp(args, USAGE.doc);
  const [action, ...params] = args;
  switch (action) {
    case "list": {
      const res: any = await apiCall("/api/v1/documents");

      const enrich = (d: any) => {
        const parts = d.id.split(":");
        if (parts.length > 1)
          d.automergeUrl = `automerge:${parts.slice(1).join(":")}`;
        return d;
      };

      console.log("Owned Documents:");
      if (res.owned && res.owned.length > 0) {
        console.table(res.owned.map(enrich));
      } else {
        console.log("(none)");
      }

      console.log("\nAccessible Documents:");
      if (res.accessible && res.accessible.length > 0) {
        console.table(res.accessible.map(enrich));
      } else {
        console.log("(none)");
      }
      break;
    }
    case "get": {
      const id = params[0];
      if (!id) throw new Error("Missing ID");
      const doc: any = await apiCall(
        `/api/v1/documents/${encodeURIComponent(id)}`,
      );

      // Derive Automerge URL from ID (assuming prefix:id format)
      // e.g. doc:uuid -> automerge:uuid
      const parts = doc.id.split(":");
      if (parts.length > 1) {
        doc.automergeUrl = `automerge:${parts.slice(1).join(":")}`;
      }

      console.table([doc]);
      break;
    }
    case "create": {
      const type = params[0];
      const config = await loadConfig();
      // Initialize repo to generate a valid Automerge ID
      const repo = await getRepo(config);
      const handle = repo.create();
      const url = handle.url;
      const automergeId = url.replace("automerge:", "");

      const id = automergeId;

      const payload = {
        id,
        automergeId,
        type,
      };

      const doc: any = await apiCall("/api/v1/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      doc.automergeUrl = url;

      console.log("Document created:");
      console.table([doc]);

      // Give the repo a moment to sync the new document to the server
      console.log("Syncing new document to server...");
      await new Promise((resolve) => setTimeout(resolve, 1000));

      process.exit(0);
      break;
    }
    case "edit": {
      const id = params[0];
      if (!id) throw new Error("Missing ID");

      let automergeUrl = id;
      if (id.startsWith("doc:")) {
        automergeUrl = id.replace(/^doc:/, "automerge:");
      } else if (!id.startsWith("automerge:")) {
        automergeUrl = `automerge:${id}`;
      }

      const config = await loadConfig();

      const repo = await getRepo(config);
      const handle = (await repo.find(
        automergeUrl as AnyDocumentId,
      )) as DocHandle<unknown>;

      console.log("Syncing...");
      try {
        await Promise.race([
          handle.whenReady(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]);
      } catch (e) {
        console.error(
          "Error: Timed out waiting for document sync. Is the ID correct and valid?",
        );
        process.exit(1);
      }

      const doc = await handle.doc();
      const content = JSON.stringify(doc, null, 2);

      const tmpDir = mkdtempSync(join(tmpdir(), "ratatoskr-"));
      const tmpFile = join(tmpDir, "doc.json");
      writeFileSync(tmpFile, content);

      const editor = process.env.EDITOR || "nano";
      console.log(`Opening ${editor}...`);

      const proc = Bun.spawnSync([editor, tmpFile], {
        stdio: ["inherit", "inherit", "inherit"],
      });

      if (proc.exitCode !== 0) {
        console.error("Editor exited with error");
      } else {
        const newContentStr = readFileSync(tmpFile, "utf-8");
        try {
          const newContent = JSON.parse(newContentStr);
          handle.change((d: any) => {
            // Simple replace strategy
            for (const key in d) delete d[key];
            Object.assign(d, newContent);
          });
          // Wait for sync to happen (best effort)
          await new Promise((r) => setTimeout(r, 500));
          console.log("Document updated.");
        } catch (e) {
          console.error("Failed to parse JSON:", e);
        }
      }

      rmSync(tmpDir, { recursive: true, force: true });
      process.exit(0);
      break;
    }
    case "watch": {
      const id = params[0];
      if (!id) throw new Error("Missing ID");

      let automergeUrl = id;
      if (id.startsWith("doc:")) {
        automergeUrl = id.replace(/^doc:/, "automerge:");
      } else if (!id.startsWith("automerge:")) {
        automergeUrl = `automerge:${id}`;
      }

      const config = await loadConfig();

      const repo = await getRepo(config);
      const handle = (await repo.find(
        automergeUrl as AnyDocumentId,
      )) as DocHandle<unknown>;

      console.log("Watching document... (Ctrl+C to stop)");

      await handle.whenReady();

      const printDoc = async () => {
        const doc = await handle.doc();
        console.clear();
        console.log(`Document: ${id}`);
        console.log("-------------------");
        console.log(JSON.stringify(doc, null, 2));
      };

      printDoc();
      handle.on("change", printDoc);

      // Keep alive
      await new Promise(() => {});
      break;
    }
    case "delete": {
      const id = params[0];
      if (!id) throw new Error("Missing ID");
      await apiCall(`/api/v1/documents/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      console.log("Document deleted");
      break;
    }
    default:
      console.error(`Unknown doc action: ${action}`);
  }
}

// Blob Handlers
async function handleBlob(args: string[]) {
  checkHelp(args, USAGE.blob);
  const [action, ...params] = args;
  switch (action) {
    case "list": {
      const res = await apiCall("/api/v1/blobs");
      console.table(res.blobs);
      break;
    }
    case "download": {
      const [hash, outfile] = params;
      if (!hash) throw new Error("Usage: blob download <hash> [outfile]");

      const response = await apiCall<Response>(`/api/v1/blobs/${hash}`); // Returns Response object

      if (!(response instanceof Response)) {
        throw new Error("Unexpected response type");
      }

      const buffer = await response.arrayBuffer();
      if (outfile) {
        await Bun.write(outfile, buffer);
        console.log(`Saved to ${outfile}`);
      } else {
        process.stdout.write(new Uint8Array(buffer));
      }
      break;
    }
    case "delete": {
      const hash = params[0];
      if (!hash) throw new Error("Usage: blob delete <hash>");
      await apiCall(`/api/v1/blobs/${hash}/claim`, { method: "DELETE" });
      console.log("Claim released");
      break;
    }
    case "upload": {
      const filePath = params[0];
      if (!filePath) throw new Error("Usage: blob upload <file>");

      const file = Bun.file(filePath);
      if (!(await file.exists())) throw new Error("File not found");

      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const size = bytes.length;
      const mimeType = file.type || "application/octet-stream";

      console.log(`Hashing ${size} bytes...`);
      const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
      const hashArray = new Uint8Array(hashBuffer);
      const expectedHash = Array.from(hashArray)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      console.log(`Hash: ${expectedHash}`);

      // Check if exists
      try {
        await apiCall(`/api/v1/blobs/${expectedHash}`, { method: "HEAD" });
        console.log("Blob already exists on server. Claiming...");
        await apiCall(`/api/v1/blobs/${expectedHash}/claim`, {
          method: "POST",
        });
        console.log("Claimed.");
        return;
      } catch (e) {
        // Not found, proceed to upload
      }

      // Init upload
      console.log("Initializing upload...");
      const initRes = await apiCall("/api/v1/blobs/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size, mimeType, expectedHash }),
      });

      const { uploadId, chunkSize, totalChunks } = initRes;

      // Upload chunks
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, size);
        const chunk = bytes.slice(start, end);

        process.stdout.write(
          `Uploading chunk ${i + 1}/${totalChunks}...
`,
        );

        await apiCall(`/api/v1/blobs/upload/${uploadId}/chunk/${i}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
        });
      }
      console.log("\nUpload complete. Finalizing...");

      // Complete
      const finalRes = await apiCall(
        `/api/v1/blobs/upload/${uploadId}/complete`,
        {
          method: "POST",
        },
      );

      console.log("Blob uploaded successfully!");
      console.table([finalRes]);
      break;
    }
    default:
      console.error(`Unknown blob action: ${action}`);
  }
}

main().catch(console.error);
