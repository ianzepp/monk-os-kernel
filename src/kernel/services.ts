/**
 * Service Management
 *
 * Socket-activated services for Monk OS.
 * Services are spawned on-demand when their activation port receives an event.
 */

/**
 * Service activation types
 */
export type ActivationType = 'tcp:listen' | 'udp:bind' | 'pubsub:subscribe' | 'fs:watch' | 'boot';

/**
 * TCP listener activation
 */
export interface TcpActivation {
    type: 'tcp:listen';
    port: number;
    host?: string;
}

/**
 * UDP activation
 */
export interface UdpActivation {
    type: 'udp:bind';
    port: number;
    host?: string;
}

/**
 * Pubsub activation
 */
export interface PubsubActivation {
    type: 'pubsub:subscribe';
    topic: string;
}

/**
 * Watch activation
 */
export interface WatchActivation {
    type: 'fs:watch';
    pattern: string;
}

/**
 * Boot activation (starts immediately on kernel boot)
 */
export interface BootActivation {
    type: 'boot';
}

/**
 * Union of all activation specs
 */
export type Activation =
    | TcpActivation
    | UdpActivation
    | PubsubActivation
    | WatchActivation
    | BootActivation;

// ============================================================================
// I/O Configuration
// ============================================================================

/**
 * File I/O source/target
 */
export interface FileIO {
    type: 'file';
    path: string;
    flags?: {
        append?: boolean;
        create?: boolean;
    };
}

/**
 * Console I/O source/target
 */
export interface ConsoleIO {
    type: 'console';
}

/**
 * Null I/O (discard writes, EOF on reads)
 */
export interface NullIO {
    type: 'null';
}

/**
 * Pubsub I/O source
 */
export interface PubsubIO {
    type: 'pubsub:subscribe';
    topics: string | string[];
}

/**
 * Watch I/O source
 */
export interface WatchIO {
    type: 'fs:watch';
    pattern: string;
}

/**
 * UDP I/O source
 */
export interface UdpIO {
    type: 'udp:bind';
    port: number;
    host?: string;
}

/**
 * Union of all I/O source types (for stdin)
 */
export type IOSource = FileIO | ConsoleIO | NullIO | PubsubIO | WatchIO | UdpIO;

/**
 * Union of all I/O target types (for stdout/stderr)
 */
export type IOTarget = FileIO | ConsoleIO | NullIO;

/**
 * Service I/O configuration
 *
 * Defines how stdin/stdout/stderr are wired for a service.
 * If not specified, defaults to console for all.
 */
export interface ServiceIO {
    /** Where stdin reads from */
    stdin?: IOSource;

    /** Where stdout writes to */
    stdout?: IOTarget;

    /** Where stderr writes to */
    stderr?: IOTarget;
}

/**
 * Service definition (matches /etc/services/*.json)
 */
export interface ServiceDef {
    /** Handler path (e.g., "/svc/telnetd") */
    handler: string;

    /** What triggers the service */
    activate: Activation;

    /** I/O configuration (stdin/stdout/stderr routing) */
    io?: ServiceIO;

    /** Optional description */
    description?: string;
}

/**
 * Handler registry entry
 *
 * Maps symbolic handler paths to actual Worker entry points.
 */
export interface HandlerEntry {
    /** Symbolic path (e.g., "/svc/telnetd") */
    path: string;

    /** Actual Worker entry file (e.g., "./rom/svc/telnetd.ts") */
    entry: string;
}

/**
 * Handler registry
 *
 * Maps handler paths to Worker entry points.
 * Built-in handlers are registered at compile time.
 */
export class HandlerRegistry {
    private handlers = new Map<string, string>();

    /**
     * Register a handler.
     *
     * @param path - Symbolic path (e.g., "/svc/telnetd")
     * @param entry - Worker entry file path
     */
    register(path: string, entry: string): void {
        this.handlers.set(path, entry);
    }

    /**
     * Get Worker entry for a handler path.
     *
     * @param path - Handler path
     * @returns Worker entry path, or undefined if not found
     */
    get(path: string): string | undefined {
        return this.handlers.get(path);
    }

    /**
     * Check if a handler is registered.
     *
     * @param path - Handler path
     */
    has(path: string): boolean {
        return this.handlers.has(path);
    }

    /**
     * List all registered handlers.
     */
    list(): string[] {
        return Array.from(this.handlers.keys());
    }
}

/**
 * Default handler registry with built-in handlers.
 */
export function createDefaultRegistry(): HandlerRegistry {
    const registry = new HandlerRegistry();

    // Built-in kernel services
    registry.register('/svc/gatewayd', './rom/svc/gatewayd.ts');

    return registry;
}
