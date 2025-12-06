/**
 * Display Subsystem - Browser-based windowing system
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The Display subsystem provides a browser-based graphical interface using EMS
 * entities. Instead of a custom display protocol, displays, windows, and elements
 * are EMS entities that:
 *
 * - CRUD via standard EntityOps (direct, not syscalls)
 * - Stream to browsers via WebSocket
 * - Leverage the observer pipeline for validation and sync
 *
 * BOOT SEQUENCE
 * =============
 * 1. Display.init() loads schema.sql into EMS database
 * 2. Models (display, window, element, event, cursor, selection) are registered
 * 3. WebSocket server starts listening for browser connections
 * 4. Each browser connection creates a display entity
 *
 * ENTITY HIERARCHY
 * ================
 * ```
 *   display (browser session)
 *      ├── window (owned by process)
 *      │      ├── element (DOM tree)
 *      │      └── selection (text selection)
 *      └── cursor (mouse state)
 * ```
 *
 * BROWSER PROTOCOL
 * ================
 * Browser and OS communicate via WebSocket using EMS operations:
 *
 * Browser → OS:
 * - { op: 'connect', data: { width, height, dpi, userAgent } }
 * - { op: 'event', data: { type, windowId, elementId, ... } }
 * - { op: 'ping' }
 * - { op: 'disconnect' }
 *
 * OS → Browser:
 * - { op: 'connected', data: { displayId } }
 * - { op: 'sync', data: { windows: [...], elements: [...] } }
 * - { op: 'update', data: { model, id, changes } }
 * - { op: 'delete', data: { model, id } }
 *
 * @module display/display
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import type { HttpServer } from '@src/hal/network.js';
import { EINVAL } from '@src/hal/errors.js';
import type { DisplayConfig } from './types.js';
import { createDisplayServer } from './server/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Path to the display schema.sql file.
 */
const SCHEMA_PATH = new URL('./schema.sql', import.meta.url).pathname;

/**
 * Default WebSocket port for browser connections.
 */
const DEFAULT_PORT = 8080;

/**
 * Default host to bind to.
 */
const DEFAULT_HOST = '0.0.0.0';

/**
 * Cached schema SQL content (Promise-based for race condition safety).
 */
let cachedSchemaPromise: Promise<string> | null = null;

// =============================================================================
// SCHEMA LOADING
// =============================================================================

/**
 * Load the display schema SQL content via HAL FileDevice.
 *
 * @param hal - HAL instance for file access
 * @returns Promise resolving to schema SQL content
 */
async function loadSchema(hal: HAL): Promise<string> {
    if (cachedSchemaPromise === null) {
        cachedSchemaPromise = hal.file.readText(SCHEMA_PATH);
    }

    return cachedSchemaPromise;
}

// =============================================================================
// DISPLAY CLASS
// =============================================================================

/**
 * Display subsystem - manages browser-based windowing.
 *
 * Follows the same lifecycle pattern as EMS and VFS:
 * - Constructor takes dependencies
 * - init() performs async initialization
 * - shutdown() performs cleanup
 */
export class Display {
    // =========================================================================
    // STATE
    // =========================================================================

    private readonly hal: HAL;
    private readonly ems: EMS;
    private readonly config: DisplayConfig;

    private initialized = false;
    private server: HttpServer | null = null;

    // =========================================================================
    // CONSTRUCTOR
    // =========================================================================

    /**
     * Create a Display subsystem instance.
     *
     * @param hal - HAL instance for hardware access
     * @param ems - EMS instance for entity operations
     * @param config - Optional configuration
     */
    constructor(hal: HAL, ems: EMS, config: DisplayConfig = {}) {
        this.hal = hal;
        this.ems = ems;
        this.config = config;
    }

    // =========================================================================
    // LIFECYCLE
    // =========================================================================

    /**
     * Initialize the Display subsystem.
     *
     * ALGORITHM:
     * 1. Load display schema.sql
     * 2. Execute schema to create tables and seed models
     * 3. Start WebSocket server for browser connections
     *
     * @throws EINVAL if already initialized
     * @throws EINVAL if EMS not initialized
     */
    async init(): Promise<void> {
        if (this.initialized) {
            throw new EINVAL('Display already initialized');
        }

        if (!this.ems.isInitialized()) {
            throw new EINVAL('EMS must be initialized before Display');
        }

        // 1. Load and execute display schema
        const schema = await loadSchema(this.hal);

        await this.ems.db.exec(schema);

        // 2. Clear model cache to pick up new models
        // WHY: EMS caches model metadata at init. Display adds new models.
        // Clearing forces reload on next access.
        this.ems.models.clear();

        // 3. Start HTTP/WebSocket server
        this.server = await createDisplayServer(this.hal, this.ems, {
            port: this.config.port ?? DEFAULT_PORT,
            host: this.config.host ?? DEFAULT_HOST,
        });

        this.initialized = true;
    }

    /**
     * Shutdown the Display subsystem.
     *
     * ALGORITHM:
     * 1. Close all browser sessions
     * 2. Stop WebSocket server
     * 3. Clean up display entities
     *
     * Safe to call multiple times.
     */
    async shutdown(): Promise<void> {
        if (!this.initialized) {
            return;
        }

        // Close HTTP/WebSocket server
        if (this.server) {
            await this.server.close();
            this.server = null;
            console.log('[display] Server stopped');
        }

        this.initialized = false;
    }

    /**
     * Check if Display is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }

    // =========================================================================
    // ACCESSORS
    // =========================================================================

    /**
     * Get the configured WebSocket port.
     */
    get port(): number {
        return this.config.port ?? DEFAULT_PORT;
    }

    /**
     * Get the configured host.
     */
    get host(): string {
        return this.config.host ?? DEFAULT_HOST;
    }

    // =========================================================================
    // SERVER ACCESS
    // =========================================================================

    /**
     * Get the server address.
     *
     * @returns Server address or null if not initialized
     */
    addr(): { hostname: string; port: number } | null {
        return this.server?.addr() ?? null;
    }
}

// =============================================================================
// EXPORTS FOR TESTING
// =============================================================================

/**
 * Clear the cached schema (for testing).
 */
export function clearSchemaCache(): void {
    cachedSchemaPromise = null;
}
