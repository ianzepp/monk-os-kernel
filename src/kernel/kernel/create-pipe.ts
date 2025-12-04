/**
 * Create a message pipe.
 *
 * @module kernel/kernel/create-pipe
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import { EMFILE } from '../errors.js';
import { MAX_HANDLES } from '../types.js';
import { createMessagePipe } from '../resource.js';
import { allocHandle } from './alloc-handle.js';

/**
 * Create a message pipe.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @returns [recvFd, sendFd]
 */
export function createPipe(self: Kernel, proc: Process): [number, number] {
    // Check limit (need 2 handles)
    if (proc.handles.size + 2 > MAX_HANDLES) {
        throw new EMFILE('Too many open handles');
    }

    const pipeId = self.hal.entropy.uuid();
    const [recvEnd, sendEnd] = createMessagePipe(pipeId);

    const recvFd = allocHandle(self, proc, recvEnd);
    const sendFd = allocHandle(self, proc, sendEnd);

    return [recvFd, sendFd];
}
