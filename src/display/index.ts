/**
 * Display Subsystem - Browser-based windowing system
 *
 * Provides a graphical interface for browsers using EMS entities.
 * Displays, windows, and elements are standard EMS entities that
 * stream to browsers via WebSocket.
 *
 * USAGE
 * =====
 * ```typescript
 * import { Display } from '@src/display/index.js';
 * import { collect } from '@src/ems/entity-ops.js';
 *
 * // Create after EMS is initialized
 * const display = new Display(hal, ems, { port: 8080 });
 * await display.init();
 *
 * // Use EMS streaming ops for entity operations
 * const [window] = await collect(ems.ops.createAll('window', [{
 *     display_id: displayId,
 *     title: 'My App',
 *     width: 800,
 *     height: 600,
 *     owner_pid: process.id,
 * }]));
 *
 * // Shutdown
 * await display.shutdown();
 * ```
 *
 * @module display
 */

// =============================================================================
// MAIN CLASS
// =============================================================================

export { Display, clearSchemaCache } from './display.js';

// =============================================================================
// SERVER
// =============================================================================

export { createDisplayServer, type DisplayServerConfig } from './server/index.js';

// =============================================================================
// ENTITY TYPES
// =============================================================================

export type {
    // Entity types
    Display as DisplayEntity,
    Window,
    Element,
    Event,
    Cursor,
    Selection,

    // Enum types
    EventType,
    CursorStyle,
    SelectionDirection,

    // Configuration
    DisplayConfig,
} from './types.js';

// =============================================================================
// PROTOCOL TYPES
// =============================================================================

export type {
    SessionData,
    ClientMessage,
    ClientMessageOp,
    ServerMessage,
    ServerMessageOp,
    ConnectData,
    EventData,
} from './server/index.js';
