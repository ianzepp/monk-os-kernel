/**
 * Display Client - Entry Point
 *
 * Browser client for Monk OS display subsystem.
 * Connects to the display server via WebSocket and renders windows/elements.
 *
 * @module display-client
 */

import { Connection } from './connection.js';

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the display client.
 */
function init(): void {
    console.log('[display-client] Initializing...');

    const connection = new Connection({}, {
        onConnected(displayId) {
            console.log('[display-client] Ready with display:', displayId);
            renderStatus('connected', displayId);
        },

        onDisconnected() {
            console.log('[display-client] Disconnected');
            renderStatus('disconnected');
        },

        onError(message) {
            console.error('[display-client] Error:', message);
            renderStatus('error', message);
        },

        onSync(data) {
            console.log('[display-client] Sync:', data);
            // TODO: Render windows and elements
        },

        onUpdate(data) {
            console.log('[display-client] Update:', data);
            // TODO: Apply incremental updates
        },

        onDelete(data) {
            console.log('[display-client] Delete:', data);
            // TODO: Remove deleted entities
        },
    });

    connection.connect();

    // Expose for debugging
    (window as any).monkDisplay = { connection };
}

/**
 * Render connection status to the page.
 */
function renderStatus(status: 'connected' | 'disconnected' | 'error', detail?: string): void {
    const statusEl = document.getElementById('status');

    if (!statusEl) {
        return;
    }

    statusEl.className = `status ${status}`;
    statusEl.textContent = detail
        ? `${status}: ${detail}`
        : status;
}

// =============================================================================
// STARTUP
// =============================================================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
}
else {
    init();
}

// =============================================================================
// EXPORTS
// =============================================================================

export { Connection } from './connection.js';
export type * from './types.js';
