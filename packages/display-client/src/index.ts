/**
 * Display Client - Entry Point
 *
 * Browser client for Monk OS display subsystem.
 * Connects to the display server via WebSocket and renders windows/elements.
 *
 * @module display-client
 */

import { Connection } from './connection.js';
import { WindowManager } from './window-manager.js';
import type { SyncData, UpdateData, DeleteData } from './types.js';

// =============================================================================
// INITIALIZATION
// =============================================================================

/**
 * Initialize the display client.
 */
function init(): void {
    console.log('[display-client] Initializing...');

    const displayEl = document.getElementById('display');

    if (!displayEl) {
        console.error('[display-client] No #display element found');
        return;
    }

    // Create window manager
    let windowManager: WindowManager | null = null;

    const connection = new Connection({}, {
        onConnected(displayId) {
            console.log('[display-client] Ready with display:', displayId);
            renderStatus('connected', displayId);

            // Hide welcome, create window manager
            const welcome = document.getElementById('welcome');

            if (welcome) {
                welcome.style.display = 'none';
            }

            windowManager = new WindowManager({
                container: displayEl,
                onEvent: (event) => connection.sendEvent(event),
            });
        },

        onDisconnected() {
            console.log('[display-client] Disconnected');
            renderStatus('disconnected');

            // Show welcome again
            const welcome = document.getElementById('welcome');

            if (welcome) {
                welcome.style.display = '';
            }

            windowManager = null;
        },

        onError(message) {
            console.error('[display-client] Error:', message);
            renderStatus('error', message);
        },

        onSync(data) {
            console.log('[display-client] Sync:', data);
            windowManager?.sync(data as SyncData);
        },

        onUpdate(data) {
            console.log('[display-client] Update:', data);
            windowManager?.update(data as UpdateData);
        },

        onDelete(data) {
            console.log('[display-client] Delete:', data);
            windowManager?.delete(data as DeleteData);
        },
    });

    connection.connect();

    // Expose for debugging
    (window as any).monkDisplay = { connection, get windowManager() { return windowManager; } };
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
