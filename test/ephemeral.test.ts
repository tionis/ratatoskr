import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// We need to mock the config before importing ephemeral
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.BASE_URL = "http://localhost:3000";
  process.env.OIDC_ISSUER = "http://localhost:8080";
  process.env.OIDC_CLIENT_ID = "test";
  process.env.OIDC_CLIENT_SECRET = "test";
  process.env.OIDC_REDIRECT_URI = "http://localhost:3000/callback";
  process.env.EPHEMERAL_TIMEOUT_SECONDS = "1"; // 1 second for faster tests
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Ephemeral Document Manager", () => {
  test("isEphemeralId correctly identifies ephemeral documents", async () => {
    const { isEphemeralId } = await import("../src/sync/ephemeral.ts");

    expect(isEphemeralId("eph:test123")).toBe(true);
    expect(isEphemeralId("eph:")).toBe(true);
    expect(isEphemeralId("doc:test123")).toBe(false);
    expect(isEphemeralId("app:test123")).toBe(false);
    expect(isEphemeralId("test123")).toBe(false);
  });

  test("ephemeral manager tracks peers", async () => {
    const { ephemeralManager } = await import("../src/sync/ephemeral.ts");

    const docId = "eph:test-doc";
    const peerId = "peer-1";

    // Add peer
    ephemeralManager.addPeer(docId, peerId);
    expect(ephemeralManager.exists(docId)).toBe(true);

    const stats = ephemeralManager.getStats();
    expect(stats.count).toBeGreaterThanOrEqual(1);
    expect(stats.totalPeers).toBeGreaterThanOrEqual(1);

    // Remove peer
    ephemeralManager.removePeer(docId, peerId);

    // Document should still exist but be scheduled for cleanup
    expect(ephemeralManager.exists(docId)).toBe(true);

    // Clean up
    ephemeralManager.shutdown();
  });

  test("ephemeral document is deleted after timeout when no peers", async () => {
    const { ephemeralManager } = await import("../src/sync/ephemeral.ts");

    const docId = "eph:timeout-test-" + Date.now();
    const peerId = "peer-timeout";

    // Add and remove peer
    ephemeralManager.addPeer(docId, peerId);
    ephemeralManager.removePeer(docId, peerId);

    // Document should exist immediately after removal
    expect(ephemeralManager.exists(docId)).toBe(true);

    // Wait for timeout (config is 1 second, wait 1.5s to be safe)
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Document should be cleaned up
    expect(ephemeralManager.exists(docId)).toBe(false);

    ephemeralManager.shutdown();
  });
});
