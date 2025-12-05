/**
 * displayd - Display server daemon for Monk OS
 *
 * Provides a browser-based windowing system using EMS entities.
 * Displays, windows, and elements are EMS entities that:
 * - Auto-expose via EntityMount at /dev/display/
 * - CRUD via standard ems:* syscalls
 * - Stream to browsers via jsond
 *
 * @module @monk-api/displayd
 */

// Re-export model types for consumers
export type {
    Display,
    Window,
    Element,
    Event,
    Cursor,
    Selection,
} from './types.js';
