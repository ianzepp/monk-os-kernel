/**
 * logd - System Log Daemon
 *
 * Receives log messages from pubsub and writes to stdout (log file).
 * This is a boot-activated service with I/O configured in the service definition.
 *
 * stdin: pubsub subscribing to log.*
 * stdout: log file (e.g., /var/log/system.log)
 *
 * The service just reads stdin and writes to stdout - the kernel handles
 * the routing based on the service's io configuration.
 */

import { readLines, println } from '@os/process';

// Format: [timestamp] [topic] message
function formatLogLine(topic: string, payload: string): string {
    const ts = new Date().toISOString();

    return `[${ts}] [${topic}] ${payload}`;
}

// Read log messages from stdin (wired to pubsub by kernel)
(async () => {
    for await (const line of readLines(0)) {
        try {
            const msg = JSON.parse(line);
            const topic = msg.from ?? 'unknown';

            // Payload might be binary (array) or object
            let payload: string;

            if (msg.data && Array.isArray(msg.data)) {
                payload = new TextDecoder().decode(new Uint8Array(msg.data));
            }
            else if (msg.meta?.message) {
                payload = String(msg.meta.message);
            }
            else {
                payload = JSON.stringify(msg);
            }

            await println(formatLogLine(topic, payload));
        }
        catch {
            // If not valid JSON, write raw
            await println(line);
        }
    }
})();
