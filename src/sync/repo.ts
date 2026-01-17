/**
 * Automerge-repo instance for the server.
 *
 * This module creates and manages the automerge-repo Repo instance,
 * which handles document synchronization.
 */

import { type PeerId, Repo } from "@automerge/automerge-repo";
import { ephemeralManager } from "./ephemeral.ts";
import { ServerNetworkAdapter } from "./network-adapter.ts";
import { RatatoskrStorageAdapter } from "./storage-adapter.ts";

let repo: Repo | null = null;
let networkAdapter: ServerNetworkAdapter | null = null;

/**
 * Initialize the automerge-repo instance.
 */
export function initRepo(): {
  repo: Repo;
  networkAdapter: ServerNetworkAdapter;
} {
  if (repo && networkAdapter) {
    return { repo, networkAdapter };
  }

  // Create storage adapter
  const storage = new RatatoskrStorageAdapter();

  // Create network adapter
  networkAdapter = new ServerNetworkAdapter();

  // Create repo
  repo = new Repo({
    storage,
    network: [networkAdapter],
    peerId: `server-${crypto.randomUUID()}` as PeerId,
    // Server should share all documents it has
    sharePolicy: async () => true,
  });

  return { repo, networkAdapter };
}

/**
 * Get the repo instance, initializing if needed.
 */
export function getRepo(): Repo {
  if (!repo) {
    initRepo();
  }
  return repo!;
}

/**
 * Get the network adapter instance.
 */
export function getNetworkAdapter(): ServerNetworkAdapter {
  if (!networkAdapter) {
    initRepo();
  }
  return networkAdapter!;
}

/**
 * Shutdown the repo.
 */
export function shutdownRepo(): void {
  ephemeralManager.shutdown();

  if (networkAdapter) {
    networkAdapter.disconnect();
    networkAdapter = null;
  }
  repo = null;
}
