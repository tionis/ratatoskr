import { describe, expect, test } from "bun:test";
import { type ACLResolver, resolvePermissions } from "../src/lib/acl.ts";

function createMockResolver(
  documents: Map<
    string,
    {
      owner: string;
      acl: { principal: string; permission: "read" | "write" }[];
    }
  >,
): ACLResolver {
  return {
    async getDocumentOwner(documentId: string) {
      return documents.get(documentId)?.owner ?? null;
    },
    async getDocumentACL(documentId: string) {
      return documents.get(documentId)?.acl ?? [];
    },
  };
}

describe("ACL Resolution", () => {
  test("owner has full access", async () => {
    const resolver = createMockResolver(
      new Map([["doc:test", { owner: "alice", acl: [] }]]),
    );

    const permissions = await resolvePermissions(resolver, "doc:test", "alice");
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(true);
  });

  test("non-owner without ACL has no access", async () => {
    const resolver = createMockResolver(
      new Map([["doc:test", { owner: "alice", acl: [] }]]),
    );

    const permissions = await resolvePermissions(resolver, "doc:test", "bob");
    expect(permissions.canRead).toBe(false);
    expect(permissions.canWrite).toBe(false);
  });

  test("read permission grants read access", async () => {
    const resolver = createMockResolver(
      new Map([
        [
          "doc:test",
          { owner: "alice", acl: [{ principal: "bob", permission: "read" }] },
        ],
      ]),
    );

    const permissions = await resolvePermissions(resolver, "doc:test", "bob");
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);
  });

  test("write permission grants read and write access", async () => {
    const resolver = createMockResolver(
      new Map([
        [
          "doc:test",
          { owner: "alice", acl: [{ principal: "bob", permission: "write" }] },
        ],
      ]),
    );

    const permissions = await resolvePermissions(resolver, "doc:test", "bob");
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(true);
  });

  test("public read grants read to all users", async () => {
    const resolver = createMockResolver(
      new Map([
        [
          "doc:test",
          {
            owner: "alice",
            acl: [{ principal: "public", permission: "read" }],
          },
        ],
      ]),
    );

    const permissions = await resolvePermissions(resolver, "doc:test", "bob");
    expect(permissions.canRead).toBe(true);
    expect(permissions.canWrite).toBe(false);

    // Also works for anonymous
    const anonPermissions = await resolvePermissions(
      resolver,
      "doc:test",
      null,
    );
    expect(anonPermissions.canRead).toBe(true);
    expect(anonPermissions.canWrite).toBe(false);
  });

  test("recursive ACL resolution", async () => {
    const resolver = createMockResolver(
      new Map([
        [
          "doc:a",
          { owner: "alice", acl: [{ principal: "doc:b", permission: "read" }] },
        ],
        [
          "doc:b",
          { owner: "bob", acl: [{ principal: "charlie", permission: "read" }] },
        ],
      ]),
    );

    // Charlie can read doc:b directly
    const charlieB = await resolvePermissions(resolver, "doc:b", "charlie");
    expect(charlieB.canRead).toBe(true);

    // Charlie can also read doc:a through the reference
    const charlieA = await resolvePermissions(resolver, "doc:a", "charlie");
    expect(charlieA.canRead).toBe(true);
  });

  test("nonexistent document returns no access", async () => {
    const resolver = createMockResolver(new Map());

    const permissions = await resolvePermissions(
      resolver,
      "doc:nonexistent",
      "alice",
    );
    expect(permissions.canRead).toBe(false);
    expect(permissions.canWrite).toBe(false);
  });

  test("cycle detection prevents infinite loops", async () => {
    const resolver = createMockResolver(
      new Map([
        [
          "doc:a",
          { owner: "alice", acl: [{ principal: "doc:b", permission: "read" }] },
        ],
        [
          "doc:b",
          { owner: "bob", acl: [{ principal: "doc:a", permission: "read" }] },
        ],
      ]),
    );

    // Should not hang
    const permissions = await resolvePermissions(resolver, "doc:a", "charlie");
    expect(permissions.canRead).toBe(false);
  });
});
