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
 *
 * // Create after EMS is initialized
 * const display = new Display(hal, ems, { port: 8080 });
 * await display.init();
 *
 * // Use EMS directly for entity operations
 * const window = await ems.ops.create('window', {
 *     display_id: displayId,
 *     title: 'My App',
 *     width: 800,
 *     height: 600,
 *     owner_pid: process.id,
 * });
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
// TYPES
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
