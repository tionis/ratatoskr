import { describe, test, expect, beforeEach } from "bun:test";
import { ConnectivityManager } from "../src/offline/connectivity-manager.ts";

describe("ConnectivityManager", () => {
  let manager: ConnectivityManager;

  beforeEach(() => {
    manager = new ConnectivityManager();
  });

  test("initial state is offline", () => {
    expect(manager.getState()).toBe("offline");
    expect(manager.isOnline()).toBe(false);
  });

  test("setServerConnecting updates state to connecting when browser is online", () => {
    // Simulate browser being online
    manager.setServerConnecting();
    expect(manager.getState()).toBe("connecting");
  });

  test("setServerConnected updates state to online when browser is online", () => {
    manager.setServerConnected();
    expect(manager.getState()).toBe("online");
    expect(manager.isOnline()).toBe(true);
    expect(manager.isServerConnected()).toBe(true);
  });

  test("setServerDisconnected updates state to offline", () => {
    manager.setServerConnected();
    expect(manager.isOnline()).toBe(true);

    manager.setServerDisconnected();
    expect(manager.getState()).toBe("offline");
    expect(manager.isOnline()).toBe(false);
  });

  test("subscribe receives state updates", () => {
    const states: string[] = [];
    manager.subscribe((state) => {
      states.push(state);
    });

    manager.setServerConnecting();
    manager.setServerConnected();
    manager.setServerDisconnected();

    expect(states).toEqual(["connecting", "online", "offline"]);
  });

  test("unsubscribe stops receiving updates", () => {
    const states: string[] = [];
    const unsubscribe = manager.subscribe((state) => {
      states.push(state);
    });

    manager.setServerConnecting();
    unsubscribe();
    manager.setServerConnected();

    expect(states).toEqual(["connecting"]);
  });

  test("waitForOnline resolves when online", async () => {
    const promise = manager.waitForOnline();

    // Simulate coming online
    setTimeout(() => {
      manager.setServerConnected();
    }, 10);

    await promise;
    expect(manager.isOnline()).toBe(true);
  });

  test("waitForOnline resolves immediately if already online", async () => {
    manager.setServerConnected();
    await manager.waitForOnline();
    expect(manager.isOnline()).toBe(true);
  });

  test("destroy cleans up listeners", () => {
    const states: string[] = [];
    manager.subscribe((state) => {
      states.push(state);
    });

    manager.destroy();
    manager.setServerConnected();

    expect(states).toEqual([]);
  });
});
