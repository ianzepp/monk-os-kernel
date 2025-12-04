/**
 * Setup service I/O using ProcessIOHandle.
 *
 * @module kernel/kernel/setup-service-io
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { ServiceDef } from '../services.js';
import { ProcessIOHandle } from '../handle.js';
import { createIOSourceHandle } from './create-io-source-handle.js';
import { createIOTargetHandle } from './create-io-target-handle.js';

/**
 * Setup service I/O using ProcessIOHandle.
 *
 * @param self - Kernel instance
 * @param proc - Process
 * @param def - Service definition
 */
export async function setupServiceIO(
    self: Kernel,
    proc: Process,
    def: ServiceDef
): Promise<void> {
    const io = def.io ?? {};

    // stdin
    const stdinSource = io.stdin
        ? await createIOSourceHandle(self, io.stdin, proc)
        : await createIOSourceHandle(self, { type: 'console' }, proc);

    const stdinHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stdin:${proc.cmd}`,
        { source: stdinSource }
    );
    self.handles.set(stdinHandle.id, stdinHandle);
    self.handleRefs.set(stdinHandle.id, 1);
    proc.handles.set(0, stdinHandle.id);

    // stdout
    const stdoutTarget = io.stdout
        ? await createIOTargetHandle(self, io.stdout)
        : await createIOTargetHandle(self, { type: 'console' });

    const stdoutHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stdout:${proc.cmd}`,
        { target: stdoutTarget }
    );
    self.handles.set(stdoutHandle.id, stdoutHandle);
    self.handleRefs.set(stdoutHandle.id, 1);
    proc.handles.set(1, stdoutHandle.id);

    // stderr
    const stderrTarget = io.stderr
        ? await createIOTargetHandle(self, io.stderr)
        : await createIOTargetHandle(self, { type: 'console' });

    const stderrHandle = new ProcessIOHandle(
        self.hal.entropy.uuid(),
        `stderr:${proc.cmd}`,
        { target: stderrTarget }
    );
    self.handles.set(stderrHandle.id, stderrHandle);
    self.handleRefs.set(stderrHandle.id, 1);
    proc.handles.set(2, stderrHandle.id);
}
