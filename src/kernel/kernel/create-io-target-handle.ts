/**
 * Create handle from IO target config.
 *
 * @module kernel/kernel/create-io-target-handle
 */

import type { Kernel } from '../kernel.js';
import type { IOTarget } from '../services.js';
import type { Handle } from '../handle.js';
import { respond } from '../../message.js';
import { FileHandleAdapter } from '../handle.js';

/**
 * Path to the console device in VFS.
 */
const CONSOLE_PATH = '/dev/console';

/**
 * Create handle from IO target config.
 *
 * @param self - Kernel instance
 * @param target - IO target configuration
 * @returns Handle
 */
export async function createIOTargetHandle(
    self: Kernel,
    target: IOTarget
): Promise<Handle> {
    switch (target.type) {
        case 'console': {
            const vfsHandle = await self.vfs.open(CONSOLE_PATH, { write: true }, 'kernel');
            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }
        case 'file': {
            const flags = {
                write: true,
                create: target.flags?.create ?? true,
                append: target.flags?.append ?? false,
            };
            const vfsHandle = await self.vfs.open(target.path, flags, 'kernel');
            return new FileHandleAdapter(vfsHandle.id, vfsHandle);
        }
        case 'null': {
            return {
                id: self.hal.entropy.uuid(),
                type: 'file' as const,
                description: '/dev/null',
                closed: false,
                async *exec() { yield respond.ok(); },
                async close() {},
            };
        }
    }
}
