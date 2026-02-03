/**
 * Client-side network adapter for Ratatoskr.
 *
 * This adapter connects to the Ratatoskr server via WebSocket
 * and handles authentication.
 */

import {
  cbor,
  type Message,
  NetworkAdapter,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo";

export interface RatatoskrNetworkAdapterOptions {
  serverUrl: string;
  token?: string;
  onConnecting?: () => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onAuthError?: (message: string) => void;
}

export class RatatoskrNetworkAdapter extends NetworkAdapter {
  private socket: WebSocket | null = null;
  private serverUrl: string;
  private token: string;
  private ready = false;
  private serverPeerId: PeerId | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private onConnecting?: () => void;
  private onConnected?: () => void;
  private onDisconnected?: () => void;
  private onAuthError?: (message: string) => void;

  constructor(options: RatatoskrNetworkAdapterOptions) {
    super();
    this.serverUrl = options.serverUrl;
    this.token = options.token ?? "";
    this.onConnecting = options.onConnecting;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onAuthError = options.onAuthError;
  }

  /**
   * Update the authentication token.
   * This forces a reconnection to authenticate with the new token.
   */
  setToken(token: string): void {
    const changed = this.token !== token;
    this.token = token;

    if (changed && this.socket) {
      // Force reconnect with new token
      this.reconnectAttempts = 0;
      this.socket.close(); // onclose will trigger doConnect which uses the new token
    }
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.socket) {
      return;
    }

    // Notify connecting
    this.onConnecting?.();

    // Convert HTTP URL to WebSocket URL
    const wsUrl = this.serverUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");

    this.socket = new WebSocket(`${wsUrl}/sync`);
    this.socket.binaryType = "arraybuffer";

    this.socket.onopen = () => {
      // Send auth message
      this.socket?.send(
        cbor.encode({
          type: "auth",
          token: this.token,
          peerId: this.peerId,
        }),
      );
    };

    this.socket.onmessage = (event) => {
      const data = event.data;
      let message: Record<string, unknown>;

      try {
        message = cbor.decode(new Uint8Array(data as ArrayBuffer)) as Record<
          string,
          unknown
        >;
      } catch {
        console.error("Failed to decode message from server");
        return;
      }

      // Handle auth response
      if (message.type === "auth_ok") {
        this.ready = true;
        this.reconnectAttempts = 0;
        this.serverPeerId =
          (message.peerId as string as PeerId) ?? ("server" as PeerId);

        // Notify connected
        this.onConnected?.();

        // Announce server as peer
        this.emit("peer-candidate", {
          peerId: this.serverPeerId,
          peerMetadata: {},
        });

        return;
      }

      if (message.type === "auth_error") {
        const errorMsg = (message.message as string) || "Authentication failed";
        console.error("Authentication failed:", errorMsg);
        this.onAuthError?.(errorMsg);
        this.socket?.close();
        return;
      }

      if (message.type === "error") {
        console.error("Server error:", message.error, message.message);
        return;
      }

      // Forward other messages to the repo
      this.emit("message", message as Message);
    };

    this.socket.onclose = () => {
      this.ready = false;
      this.socket = null;

      // Notify disconnected
      this.onDisconnected?.();

      if (this.serverPeerId) {
        this.emit("peer-disconnected", { peerId: this.serverPeerId });
        this.serverPeerId = null;
      }

      // Attempt reconnection
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * 2 ** (this.reconnectAttempts - 1);
        setTimeout(() => this.doConnect(), delay);
      }
    };

    this.socket.onerror = (error) => {
      console.error("WebSocket error:", error);
    };
  }

  disconnect(): void {
    this.ready = false;
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.emit("close");
  }

  send(message: Message): void {
    if (!this.socket || !this.ready) {
      console.warn("Cannot send message: not connected");
      return;
    }

    // Target the server
    const targetedMessage = {
      ...message,
      targetId: this.serverPeerId,
    };

    this.socket.send(cbor.encode(targetedMessage));
  }

  isReady(): boolean {
    return this.ready;
  }

  async whenReady(): Promise<void> {
    if (this.ready) return;
    return new Promise((resolve) => {
      this.once("peer-candidate", () => resolve());
    });
  }
}
