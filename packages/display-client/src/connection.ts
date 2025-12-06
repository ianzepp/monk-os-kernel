/**
 * Display Client - WebSocket Connection
 *
 * Manages WebSocket connection to the display server.
 * Handles connect/disconnect, message sending, and reconnection.
 *
 * @module display-client/connection
 */

import type {
    ClientMessage,
    ServerMessage,
    ConnectData,
    EventData,
    ConnectedData,
} from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ConnectionConfig {
    /** WebSocket URL (default: ws://localhost:8080/ws) */
    url?: string;

    /** Reconnect on disconnect (default: true) */
    reconnect?: boolean;

    /** Reconnect delay in ms (default: 1000) */
    reconnectDelay?: number;

    /** Ping interval in ms (default: 30000) */
    pingInterval?: number;
}

export interface ConnectionEvents {
    onConnected?: (displayId: string) => void;
    onDisconnected?: () => void;
    onError?: (error: string) => void;
    onSync?: (data: unknown) => void;
    onUpdate?: (data: unknown) => void;
    onDelete?: (data: unknown) => void;
}

// =============================================================================
// CONNECTION CLASS
// =============================================================================

/**
 * WebSocket connection to display server.
 */
export class Connection {
    private config: Required<ConnectionConfig>;
    private events: ConnectionEvents;
    private ws: WebSocket | null = null;
    private displayId: string | null = null;
    private pingTimer: number | null = null;
    private reconnectTimer: number | null = null;
    private intentionalClose = false;

    constructor(config: ConnectionConfig = {}, events: ConnectionEvents = {}) {
        this.config = {
            url: config.url ?? `ws://${window.location.host}/ws`,
            reconnect: config.reconnect ?? true,
            reconnectDelay: config.reconnectDelay ?? 1000,
            pingInterval: config.pingInterval ?? 30000,
        };
        this.events = events;
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Connect to the display server.
     */
    connect(): void {
        if (this.ws) {
            return;
        }

        this.intentionalClose = false;
        this.ws = new WebSocket(this.config.url);

        this.ws.onopen = () => {
            console.log('[display-client] WebSocket connected');
            this.sendConnect();
            this.startPing();
        };

        this.ws.onmessage = (event) => {
            this.handleMessage(event.data);
        };

        this.ws.onclose = () => {
            console.log('[display-client] WebSocket closed');
            this.cleanup();
            this.events.onDisconnected?.();

            if (this.config.reconnect && !this.intentionalClose) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (event) => {
            console.error('[display-client] WebSocket error:', event);
        };
    }

    /**
     * Disconnect from the display server.
     */
    disconnect(): void {
        this.intentionalClose = true;
        this.send({ op: 'disconnect' });
        this.ws?.close();
        this.cleanup();
    }

    /**
     * Send an event to the server.
     */
    sendEvent(data: EventData): void {
        this.send({ op: 'event', data });
    }

    /**
     * Get the display ID (null if not connected).
     */
    getDisplayId(): string | null {
        return this.displayId;
    }

    /**
     * Check if connected.
     */
    isConnected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN && this.displayId !== null;
    }

    // =========================================================================
    // PRIVATE
    // =========================================================================

    private send(message: ClientMessage): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }

    private sendConnect(): void {
        const data: ConnectData = {
            width: window.innerWidth,
            height: window.innerHeight,
            dpi: window.devicePixelRatio * 96,
            userAgent: navigator.userAgent,
        };

        this.send({ op: 'connect', data });
    }

    private handleMessage(raw: string): void {
        let msg: ServerMessage;

        try {
            msg = JSON.parse(raw);
        }
        catch {
            console.error('[display-client] Invalid message:', raw);
            return;
        }

        switch (msg.op) {
            case 'connected': {
                const data = msg.data as ConnectedData;
                this.displayId = data.displayId;
                console.log('[display-client] Connected with displayId:', this.displayId);
                this.events.onConnected?.(this.displayId);
                break;
            }

            case 'sync':
                this.events.onSync?.(msg.data);
                break;

            case 'update':
                this.events.onUpdate?.(msg.data);
                break;

            case 'delete':
                this.events.onDelete?.(msg.data);
                break;

            case 'error': {
                const data = msg.data as { message: string };
                console.error('[display-client] Server error:', data.message);
                this.events.onError?.(data.message);
                break;
            }

            case 'pong':
                // Ping acknowledged
                break;

            default:
                console.warn('[display-client] Unknown message op:', msg.op);
        }
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = window.setInterval(() => {
            this.send({ op: 'ping' });
        }, this.config.pingInterval);
    }

    private stopPing(): void {
        if (this.pingTimer !== null) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer !== null) {
            return;
        }

        console.log(`[display-client] Reconnecting in ${this.config.reconnectDelay}ms...`);

        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.config.reconnectDelay);
    }

    private cleanup(): void {
        this.stopPing();
        this.ws = null;
        this.displayId = null;

        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
