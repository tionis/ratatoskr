/**
 * Connectivity manager for monitoring browser and server connection state.
 *
 * Combines browser online/offline events with WebSocket connection state
 * to provide a unified connectivity status.
 */

export type ConnectivityState = "online" | "offline" | "connecting";

export type ConnectivityListener = (state: ConnectivityState) => void;

export class ConnectivityManager {
  private state: ConnectivityState = "offline";
  private listeners: Set<ConnectivityListener> = new Set();
  private browserOnline: boolean;
  private serverConnected: boolean = false;
  private serverConnecting: boolean = false;

  constructor() {
    // Check navigator.onLine, defaulting to true if unavailable or undefined
    this.browserOnline =
      typeof navigator !== "undefined" && typeof navigator.onLine === "boolean"
        ? navigator.onLine
        : true;

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleBrowserOnline);
      window.addEventListener("offline", this.handleBrowserOffline);
    }

    this.updateState();
  }

  private handleBrowserOnline = (): void => {
    this.browserOnline = true;
    this.updateState();
  };

  private handleBrowserOffline = (): void => {
    this.browserOnline = false;
    this.updateState();
  };

  /**
   * Called by the network adapter when WebSocket connection starts.
   */
  setServerConnecting(): void {
    this.serverConnecting = true;
    this.serverConnected = false;
    this.updateState();
  }

  /**
   * Called by the network adapter when WebSocket is connected and authenticated.
   */
  setServerConnected(): void {
    this.serverConnected = true;
    this.serverConnecting = false;
    this.updateState();
  }

  /**
   * Called by the network adapter when WebSocket disconnects.
   */
  setServerDisconnected(): void {
    this.serverConnected = false;
    this.serverConnecting = false;
    this.updateState();
  }

  private updateState(): void {
    let newState: ConnectivityState;

    if (!this.browserOnline) {
      newState = "offline";
    } else if (this.serverConnected) {
      newState = "online";
    } else if (this.serverConnecting) {
      newState = "connecting";
    } else {
      newState = "offline";
    }

    if (newState !== this.state) {
      this.state = newState;
      this.notifyListeners();
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("Error in connectivity listener:", error);
      }
    }
  }

  /**
   * Get the current connectivity state.
   */
  getState(): ConnectivityState {
    return this.state;
  }

  /**
   * Check if currently online (browser + server connected).
   */
  isOnline(): boolean {
    return this.state === "online";
  }

  /**
   * Check if browser reports being online (may not be connected to server).
   */
  isBrowserOnline(): boolean {
    return this.browserOnline;
  }

  /**
   * Check if connected to the server.
   */
  isServerConnected(): boolean {
    return this.serverConnected;
  }

  /**
   * Subscribe to connectivity state changes.
   */
  subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Wait for online state.
   */
  async waitForOnline(): Promise<void> {
    if (this.state === "online") {
      return;
    }

    return new Promise((resolve) => {
      const unsubscribe = this.subscribe((state) => {
        if (state === "online") {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Cleanup event listeners.
   */
  destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleBrowserOnline);
      window.removeEventListener("offline", this.handleBrowserOffline);
    }
    this.listeners.clear();
  }
}
