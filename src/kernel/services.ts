/**
 * Service Management
 *
 * Socket-activated services for Monk OS.
 * Services are spawned on-demand when their activation port receives an event.
 */

/**
 * Service activation types
 */
export type ActivationType = 'tcp:listen' | 'udp' | 'pubsub' | 'watch' | 'boot';

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
    type: 'udp';
    port: number;
    host?: string;
}

/**
 * Pubsub activation
 */
export interface PubsubActivation {
    type: 'pubsub';
    topic: string;
}

/**
 * Watch activation
 */
export interface WatchActivation {
    type: 'watch';
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

/**
 * Service definition (matches /etc/services/*.json)
 */
export interface ServiceDef {
    /** Handler path (e.g., "/bin/telnetd") */
    handler: string;

    /** What triggers the service */
    activate: Activation;

    /** Optional description */
    description?: string;
}

/**
 * Handler registry entry
 *
 * Maps symbolic handler paths to actual Worker entry points.
 */
export interface HandlerEntry {
    /** Symbolic path (e.g., "/bin/telnetd") */
    path: string;

    /** Actual Worker entry file (e.g., "./src/bin/telnetd.ts") */
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
     * @param path - Symbolic path (e.g., "/bin/telnetd")
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

    // Built-in handlers
    // These paths are relative to the compiled executable's context
    registry.register('/bin/telnetd', './src/bin/telnetd.ts');

    return registry;
}
