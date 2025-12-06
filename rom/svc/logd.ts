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

import { read, println } from '@src/process/index.js';

// Format: [timestamp] [topic] message
function formatLogLine(topic: string, payload: string): string {
    const ts = new Date().toISOString();

    return `[${ts}] [${topic}] ${payload}`;
}

/**
 * Read lines from stdin.
 * Simple line reader that yields complete lines.
 */
async function* readLines(fd: number): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const chunk = await read(fd);

        if (chunk.length === 0) {
            // EOF - yield any remaining buffer
            if (buffer.length > 0) {
                yield buffer;
            }

            break;
        }

        buffer += decoder.decode(chunk, { stream: true });

        // Yield complete lines
        let newlineIdx: number;

        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            yield buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
        }
    }
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
