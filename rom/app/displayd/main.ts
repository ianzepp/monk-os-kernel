/**
 * displayd - Display Server
 *
 * Thin translation layer between EMS display entities and browser clients.
 * The heavy lifting is done by:
 * - EMS (entity storage, observer pipeline)
 * - Gateway (WebSocket/MessagePack wire protocol)
 * - Dispatcher (syscall routing)
 *
 * This service handles display-specific lifecycle:
 * - Session cleanup on disconnect
 * - Heartbeat monitoring
 * - Window focus management
 */

import {
    getpid,
    println,
    onSignal,
    sleep,
} from '@rom/lib/process/index.js';

export default async function main(): Promise<void> {
    const pid = await getpid();

    await println(`displayd: starting (pid ${pid})`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('displayd: received shutdown signal');
    });

    // Main loop
    while (running) {
        // TODO: Heartbeat monitoring - check last_ping on displays
        // TODO: Session cleanup - mark disconnected displays
        // TODO: Window focus management

        await sleep(1000);
    }

    await println('displayd: shutdown complete');
}
