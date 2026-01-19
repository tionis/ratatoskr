import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  ConnectivityManager,
  type ConnectivityState,
} from "../src/offline/connectivity-manager.ts";

describe("ConnectivityManager", () => {
  let manager: ConnectivityManager;

  beforeEach(() => {
    manager = new ConnectivityManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  describe("initial state", () => {
    test("initial state is offline", () => {
      expect(manager.getState()).toBe("offline");
      expect(manager.isOnline()).toBe(false);
    });

    test("isServerConnected returns false initially", () => {
      expect(manager.isServerConnected()).toBe(false);
    });

    test("isBrowserOnline defaults to true when navigator.onLine unavailable", () => {
      // In Bun test environment, navigator.onLine is true by default
      expect(manager.isBrowserOnline()).toBe(true);
    });
  });

  describe("setServerConnecting()", () => {
    test("updates state to connecting when browser is online", () => {
      manager.setServerConnecting();
      expect(manager.getState()).toBe("connecting");
    });

    test("sets serverConnected to false", () => {
      manager.setServerConnected();
      expect(manager.isServerConnected()).toBe(true);

      manager.setServerConnecting();
      expect(manager.isServerConnected()).toBe(false);
    });

    test("notifies listeners of state change", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerConnecting();

      expect(states).toEqual(["connecting"]);
    });

    test("does not notify if state unchanged", () => {
      manager.setServerConnecting();

      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerConnecting();

      expect(states).toHaveLength(0);
    });
  });

  describe("setServerConnected()", () => {
    test("updates state to online when browser is online", () => {
      manager.setServerConnected();
      expect(manager.getState()).toBe("online");
      expect(manager.isOnline()).toBe(true);
      expect(manager.isServerConnected()).toBe(true);
    });

    test("clears connecting state", () => {
      manager.setServerConnecting();
      expect(manager.getState()).toBe("connecting");

      manager.setServerConnected();
      expect(manager.getState()).toBe("online");
    });

    test("notifies listeners", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerConnected();

      expect(states).toEqual(["online"]);
    });
  });

  describe("setServerDisconnected()", () => {
    test("updates state to offline", () => {
      manager.setServerConnected();
      expect(manager.isOnline()).toBe(true);

      manager.setServerDisconnected();
      expect(manager.getState()).toBe("offline");
      expect(manager.isOnline()).toBe(false);
    });

    test("clears both connected and connecting states", () => {
      manager.setServerConnecting();
      manager.setServerDisconnected();

      expect(manager.isServerConnected()).toBe(false);
      expect(manager.getState()).toBe("offline");
    });

    test("notifies listeners", () => {
      manager.setServerConnected();

      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerDisconnected();

      expect(states).toEqual(["offline"]);
    });
  });

  describe("subscribe()", () => {
    test("receives state updates", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => {
        states.push(state);
      });

      manager.setServerConnecting();
      manager.setServerConnected();
      manager.setServerDisconnected();

      expect(states).toEqual(["connecting", "online", "offline"]);
    });

    test("multiple listeners all receive updates", () => {
      const states1: ConnectivityState[] = [];
      const states2: ConnectivityState[] = [];

      manager.subscribe((state) => states1.push(state));
      manager.subscribe((state) => states2.push(state));

      manager.setServerConnected();

      expect(states1).toEqual(["online"]);
      expect(states2).toEqual(["online"]);
    });

    test("listener errors do not affect other listeners", () => {
      const states: ConnectivityState[] = [];
      const originalError = console.error;
      console.error = () => {}; // Suppress expected error output

      try {
        manager.subscribe(() => {
          throw new Error("Listener error");
        });
        manager.subscribe((state) => states.push(state));

        manager.setServerConnected();

        expect(states).toEqual(["online"]);
      } finally {
        console.error = originalError;
      }
    });

    test("returns unsubscribe function", () => {
      const states: ConnectivityState[] = [];
      const unsubscribe = manager.subscribe((state) => {
        states.push(state);
      });

      expect(typeof unsubscribe).toBe("function");
    });
  });

  describe("unsubscribe", () => {
    test("stops receiving updates", () => {
      const states: ConnectivityState[] = [];
      const unsubscribe = manager.subscribe((state) => {
        states.push(state);
      });

      manager.setServerConnecting();
      unsubscribe();
      manager.setServerConnected();

      expect(states).toEqual(["connecting"]);
    });

    test("can be called multiple times safely", () => {
      const unsubscribe = manager.subscribe(() => {});

      unsubscribe();
      unsubscribe();
      unsubscribe();
      // Should not throw
    });

    test("does not affect other listeners", () => {
      const states1: ConnectivityState[] = [];
      const states2: ConnectivityState[] = [];

      const unsubscribe1 = manager.subscribe((state) => states1.push(state));
      manager.subscribe((state) => states2.push(state));

      unsubscribe1();
      manager.setServerConnected();

      expect(states1).toHaveLength(0);
      expect(states2).toEqual(["online"]);
    });
  });

  describe("waitForOnline()", () => {
    test("resolves when online", async () => {
      const promise = manager.waitForOnline();

      // Simulate coming online
      setTimeout(() => {
        manager.setServerConnected();
      }, 10);

      await promise;
      expect(manager.isOnline()).toBe(true);
    });

    test("resolves immediately if already online", async () => {
      manager.setServerConnected();
      const start = Date.now();
      await manager.waitForOnline();
      const duration = Date.now() - start;

      expect(manager.isOnline()).toBe(true);
      expect(duration).toBeLessThan(50);
    });

    test("multiple waiters all resolve", async () => {
      const promise1 = manager.waitForOnline();
      const promise2 = manager.waitForOnline();
      const promise3 = manager.waitForOnline();

      setTimeout(() => {
        manager.setServerConnected();
      }, 10);

      await Promise.all([promise1, promise2, promise3]);
      expect(manager.isOnline()).toBe(true);
    });

    test("unsubscribes after resolving", async () => {
      const promise = manager.waitForOnline();

      manager.setServerConnected();
      await promise;

      // Going offline and online again should not affect anything
      manager.setServerDisconnected();
      manager.setServerConnected();
      // No errors expected
    });
  });

  describe("getState()", () => {
    test("returns current connectivity state", () => {
      expect(manager.getState()).toBe("offline");

      manager.setServerConnecting();
      expect(manager.getState()).toBe("connecting");

      manager.setServerConnected();
      expect(manager.getState()).toBe("online");

      manager.setServerDisconnected();
      expect(manager.getState()).toBe("offline");
    });
  });

  describe("isOnline()", () => {
    test("returns true only when state is online", () => {
      expect(manager.isOnline()).toBe(false);

      manager.setServerConnecting();
      expect(manager.isOnline()).toBe(false);

      manager.setServerConnected();
      expect(manager.isOnline()).toBe(true);

      manager.setServerDisconnected();
      expect(manager.isOnline()).toBe(false);
    });
  });

  describe("isBrowserOnline()", () => {
    test("returns browser online status", () => {
      // In test environment, browser is considered online
      expect(manager.isBrowserOnline()).toBe(true);
    });
  });

  describe("isServerConnected()", () => {
    test("returns server connection status", () => {
      expect(manager.isServerConnected()).toBe(false);

      manager.setServerConnecting();
      expect(manager.isServerConnected()).toBe(false);

      manager.setServerConnected();
      expect(manager.isServerConnected()).toBe(true);

      manager.setServerDisconnected();
      expect(manager.isServerConnected()).toBe(false);
    });
  });

  describe("destroy()", () => {
    test("cleans up listeners", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => {
        states.push(state);
      });

      manager.destroy();
      manager.setServerConnected();

      expect(states).toEqual([]);
    });

    test("can be called multiple times", () => {
      manager.destroy();
      manager.destroy();
      // Should not throw
    });

    test("clears all subscribers", () => {
      const listener1 = mock(() => {});
      const listener2 = mock(() => {});

      manager.subscribe(listener1);
      manager.subscribe(listener2);

      manager.destroy();
      manager.setServerConnected();

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });
  });

  describe("state transitions", () => {
    test("offline -> connecting -> online -> offline cycle", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      expect(manager.getState()).toBe("offline");

      manager.setServerConnecting();
      manager.setServerConnected();
      manager.setServerDisconnected();

      expect(states).toEqual(["connecting", "online", "offline"]);
    });

    test("direct offline -> online transition", () => {
      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerConnected();

      expect(states).toEqual(["online"]);
      expect(manager.getState()).toBe("online");
    });

    test("connecting -> disconnected transition", () => {
      manager.setServerConnecting();

      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerDisconnected();

      expect(states).toEqual(["offline"]);
    });

    test("repeated same state does not trigger notification", () => {
      manager.setServerConnected();

      const states: ConnectivityState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.setServerConnected();
      manager.setServerConnected();
      manager.setServerConnected();

      expect(states).toHaveLength(0);
    });
  });
});
