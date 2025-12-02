/**
 * Resource Types
 *
 * Shared types and interfaces for port implementations.
 */

import type { Socket } from '@src/hal/index.js';
import type { PortType } from '@src/kernel/types.js';

export type { PortType } from '@src/kernel/types.js';

/**
 * Message received from a port.
 *
 * For tcp:listen: socket contains the accepted connection
 * For udp: data contains the network payload (required)
 * For pubsub/watch: meta contains structured data (data optional)
 */
export interface PortMessage {
    /** Source identifier (remote address, topic, path) */
    from: string;

    /** Binary payload - required for UDP (network boundary), optional for pubsub/watch */
    data?: Uint8Array;

    /** Accepted socket for tcp:listen */
    socket?: Socket;

    /** Structured metadata - primary carrier for pubsub/watch messages */
    meta?: Record<string, unknown>;
}

/**
 * Base port interface
 */
export interface Port {
    /** Unique port identifier */
    readonly id: string;

    /** Port type */
    readonly type: PortType;

    /** Human-readable description */
    readonly description: string;

    /** Receive next message (blocks until available) */
    recv(): Promise<PortMessage>;

    /** Send message to destination (not all ports support this) */
    send(to: string, data?: Uint8Array, meta?: Record<string, unknown>): Promise<void>;

    /** Close port */
    close(): Promise<void>;

    /** Check if closed */
    readonly closed: boolean;
}

/**
 * UDP socket options
 */
export interface UdpSocketOpts {
    /** Local port to bind */
    bind: number;
    /** Local address (default: 0.0.0.0) */
    address?: string;
}
