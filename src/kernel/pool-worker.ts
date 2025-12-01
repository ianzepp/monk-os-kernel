/**
 * Pool Worker Runtime
 *
 * Runs inside each pooled worker. Handles:
 * - Loading scripts dynamically
 * - Message passing to/from loaded handler
 * - State reset between uses
 */

/** Currently loaded handler */
let currentHandler: ((msg: unknown) => AsyncIterable<unknown> | Promise<unknown> | unknown) | null = null;

/**
 * Handle messages from pool manager
 */
self.onmessage = async (e: MessageEvent) => {
    const msg = e.data as { type: string; path?: string; data?: unknown };

    switch (msg.type) {
        case 'load': {
            try {
                // Dynamic import of the handler script
                const module = await import(msg.path!);
                currentHandler = module.default ?? module.handle ?? module.handler;

                if (typeof currentHandler !== 'function') {
                    throw new Error(`No handler function exported from ${msg.path}`);
                }

                self.postMessage({ type: 'loaded' });
            } catch (err) {
                const error = err as Error;
                self.postMessage({ type: 'error', error: error.message });
            }
            break;
        }

        case 'message': {
            if (!currentHandler) {
                self.postMessage({ type: 'error', error: 'No handler loaded' });
                break;
            }

            try {
                const result = currentHandler(msg.data);

                // Handle async iterables (streaming)
                if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
                    for await (const item of result as AsyncIterable<unknown>) {
                        self.postMessage({ type: 'message', data: item });
                    }
                    self.postMessage({ type: 'done' });
                }
                // Handle promises
                else if (result instanceof Promise) {
                    const resolved = await result;
                    self.postMessage({ type: 'message', data: resolved });
                }
                // Handle sync results
                else {
                    self.postMessage({ type: 'message', data: result });
                }
            } catch (err) {
                const error = err as Error;
                self.postMessage({
                    type: 'error',
                    error: error.message,
                    stack: error.stack,
                });
            }
            break;
        }

        case 'reset': {
            // Clear handler for next use
            currentHandler = null;
            // Note: We can't fully reset module cache in a worker,
            // but clearing the handler reference helps GC
            break;
        }

        default:
            self.postMessage({ type: 'error', error: `Unknown message type: ${msg.type}` });
    }
};

// Signal ready
self.postMessage({ type: 'ready' });
