import {
  createUser,
  deleteBlob,
  deleteDocument,
  getAllBlobs,
  getAllDocuments,
  getAllUsers,
  getBlob,
  getDocument,
  getUser,
  kvDelete,
  kvGet,
  kvList,
  kvSet,
} from "./storage/database.ts";
import { readDocument } from "./storage/documents.ts";

export async function runAdminCli(args: string[]) {
  if (args.length === 0) {
    printHelp();
    return;
  }

  const [category, action, ...params] = args;

  if (
    !action &&
    category !== "help" &&
    category !== "--help" &&
    category !== "-h"
  ) {
    printHelp();
    return;
  }

  try {
    switch (category) {
      case "user":
        await handleUser(action!, params);
        break;
      case "doc":
        await handleDoc(action!, params);
        break;
      case "blob":
        await handleBlob(action!, params);
        break;
      case "kv":
        await handleKv(action!, params);
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`Unknown category: ${category}`);
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
Ratatoskr Server & Admin CLI

Usage:
  ratatoskr [server]          Start the server (default)
  ratatoskr <category> <cmd>  Run admin command

Categories:
  user, doc, blob, kv

Commands:
  user list [limit] [offset]
  user get <id>
  user create <id> [email] [name]

  doc list [limit] [offset]
  doc get <id>
  doc cat <id>
  doc delete <id>

  blob list [limit] [offset]
  blob get <hash>
  blob delete <hash>

  kv list <userId> <namespace>
  kv get <userId> <namespace> <key>
  kv set <userId> <namespace> <key> <value>
  kv delete <userId> <namespace> <key>
`);
}

async function handleUser(action: string, params: string[]) {
  switch (action) {
    case "list": {
      const limit = Number(params[0] ?? 100);
      const offset = Number(params[1] ?? 0);
      const users = getAllUsers(limit, offset);
      console.table(users);
      break;
    }
    case "get": {
      const id = params[0];
      if (!id) throw new Error("Missing user ID");
      const user = getUser(id);
      if (!user) console.error("User not found");
      else console.table([user]);
      break;
    }
    case "create": {
      const [id, email, name] = params;
      if (!id) throw new Error("Missing user ID");
      const user = createUser({ id, email: email ?? null, name: name ?? null });
      console.log("User created:");
      console.table([user]);
      break;
    }
    default:
      console.error(`Unknown user action: ${action}`);
      printHelp();
  }
}

async function handleDoc(action: string, params: string[]) {
  switch (action) {
    case "list": {
      const limit = Number(params[0] ?? 100);
      const offset = Number(params[1] ?? 0);
      const docs = getAllDocuments(limit, offset);
      console.table(docs);
      break;
    }
    case "get": {
      const id = params[0];
      if (!id) throw new Error("Missing document ID");
      const doc = getDocument(id);
      if (!doc) console.error("Document not found");
      else console.table([doc]);
      break;
    }
    case "cat": {
      const id = params[0];
      if (!id) throw new Error("Missing document ID");
      const data = await readDocument(id);
      if (!data) {
        console.error("Document file not found");
        return;
      }
      // Try to print as text
      const text = new TextDecoder().decode(data);
      console.log(text);
      break;
    }
    case "delete": {
      const id = params[0];
      if (!id) throw new Error("Missing document ID");
      const success = deleteDocument(id);
      if (success) console.log(`Document ${id} deleted`);
      else console.error(`Failed to delete document ${id} (not found?)`);
      break;
    }
    default:
      console.error(`Unknown doc action: ${action}`);
      printHelp();
  }
}

async function handleBlob(action: string, params: string[]) {
  switch (action) {
    case "list": {
      const limit = Number(params[0] ?? 100);
      const offset = Number(params[1] ?? 0);
      const blobs = getAllBlobs(limit, offset);
      console.table(blobs);
      break;
    }
    case "get": {
      const hash = params[0];
      if (!hash) throw new Error("Missing blob hash");
      const blob = getBlob(hash);
      if (!blob) console.error("Blob not found");
      else console.table([blob]);
      break;
    }
    case "delete": {
      const hash = params[0];
      if (!hash) throw new Error("Missing blob hash");
      const success = deleteBlob(hash);
      if (success) console.log(`Blob ${hash} deleted`);
      else console.error(`Failed to delete blob ${hash} (not found?)`);
      break;
    }
    default:
      console.error(`Unknown blob action: ${action}`);
      printHelp();
  }
}

async function handleKv(action: string, params: string[]) {
  switch (action) {
    case "list": {
      const [userId, namespace] = params;
      if (!userId || !namespace)
        throw new Error("Usage: kv list <userId> <namespace>");
      const entries = kvList(userId, namespace);
      console.table(entries);
      break;
    }
    case "get": {
      const [userId, namespace, key] = params;
      if (!userId || !namespace || !key)
        throw new Error("Usage: kv get <userId> <namespace> <key>");
      const value = kvGet(userId, namespace, key);
      if (value === null) console.error("Key not found");
      else console.log(value);
      break;
    }
    case "set": {
      const [userId, namespace, key, value] = params;
      if (!userId || !namespace || !key || value === undefined)
        throw new Error("Usage: kv set <userId> <namespace> <key> <value>");
      kvSet(userId, namespace, key, value);
      console.log(`Set ${namespace}:${key} = ${value}`);
      break;
    }
    case "delete": {
      const [userId, namespace, key] = params;
      if (!userId || !namespace || !key)
        throw new Error("Usage: kv delete <userId> <namespace> <key>");
      const success = kvDelete(userId, namespace, key);
      if (success) console.log(`Deleted ${namespace}:${key}`);
      else console.error("Key not found");
      break;
    }
    default:
      console.error(`Unknown kv action: ${action}`);
      printHelp();
  }
}
