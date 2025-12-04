/**
 * Setup a stdio handle to console for services.
 *
 * @module kernel/kernel/setup-service-stdio
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { FileHandleAdapter } from '../handle.js';

/**
 * Path to the console device in VFS.
 * Used for init process stdio and service default I/O.
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Setup a stdio handle to console for services.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param h - Handle number (0=stdin, 1=stdout, 2=stderr)
 */
export async function setupServiceStdio(
    self: Kernel,
    proc: Process,
    h: number
): Promise<void> {
    const flags = h === 0 ? { read: true } : { write: true };
    const vfsHandle = await self.vfs.open(CONSOLE_PATH, flags, 'kernel');
    const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
    self.handles.set(adapter.id, adapter);
    self.handleRefs.set(adapter.id, 1);
    proc.handles.set(h, adapter.id);
}
