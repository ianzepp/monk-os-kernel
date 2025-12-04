/**
 * Polling utility for async condition waiting.
 */

export interface PollOptions {
    /** Poll interval in milliseconds. Default: 10ms */
    interval?: number;
    /** Timeout in milliseconds. Default: 5000ms */
    timeout?: number;
}

/**
 * Poll until condition returns true, or timeout.
 *
 * @param condition - Function that returns true when done waiting
 * @param options - Poll interval and timeout settings
 * @returns true if condition was met, false if timed out
 *
 * @example
 * // Wait for process to exit
 * const exited = await poll(() => proc.state === 'zombie');
 * if (!exited) throw new ETIMEDOUT('Process did not exit');
 *
 * @example
 * // Custom interval and timeout
 * await poll(() => queue.length === 0, { interval: 50, timeout: 10000 });
 */
export async function poll(
    condition: () => boolean | Promise<boolean>,
    options: PollOptions = {}
): Promise<boolean> {
    const { interval = 10, timeout = 5000 } = options;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        if (await condition()) return true;
        await new Promise(r => setTimeout(r, interval));
    }
    return false;
}
