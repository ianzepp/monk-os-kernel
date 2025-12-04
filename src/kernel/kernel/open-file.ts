/**
 * Open a file and allocate handle.
 *
 * @module kernel/kernel/open-file
 */

import type { Kernel } from '../kernel.js';
import type { Process, OpenFlags } from '../types.js';
import { FileHandleAdapter } from '../handle.js';
import { allocHandle } from './alloc-handle.js';

/**
 * Open a file and allocate handle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param path - File path
 * @param flags - Open flags
 * @returns File descriptor number
 */
export async function openFile(
    self: Kernel,
    proc: Process,
    path: string,
    flags: OpenFlags
): Promise<number> {
    const vfsHandle = await self.vfs.open(path, flags, proc.id);
    const adapter = new FileHandleAdapter(vfsHandle.id, vfsHandle);
    return allocHandle(self, proc, adapter);
}
