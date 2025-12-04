/**
 * Setup stdio for init process.
 *
 * Uses ConsoleHandleAdapter for message-based I/O to the console.
 * This is the boundary where Response messages become bytes.
 *
 * @module kernel/kernel/setup-init-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { ConsoleHandleAdapter } from '../handle.js';

/**
 * Setup stdio for init process.
 *
 * @param self - Kernel instance
 * @param init - Init process
 */
export async function setupInitStdio(self: Kernel, init: Process): Promise<void> {
    // stdin (fd 0)
    const stdinAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),
        self.hal.console,
        'stdin'
    );
    self.handles.set(stdinAdapter.id, stdinAdapter);
    self.handleRefs.set(stdinAdapter.id, 1);
    init.handles.set(0, stdinAdapter.id);

    // stdout (fd 1)
    const stdoutAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),
        self.hal.console,
        'stdout'
    );
    self.handles.set(stdoutAdapter.id, stdoutAdapter);
    self.handleRefs.set(stdoutAdapter.id, 1);
    init.handles.set(1, stdoutAdapter.id);

    // stderr (fd 2)
    const stderrAdapter = new ConsoleHandleAdapter(
        self.hal.entropy.uuid(),
        self.hal.console,
        'stderr'
    );
    self.handles.set(stderrAdapter.id, stderrAdapter);
    self.handleRefs.set(stderrAdapter.id, 1);
    init.handles.set(2, stderrAdapter.id);
}
