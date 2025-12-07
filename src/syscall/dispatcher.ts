/**
 * SyscallDispatcher - Switch-based routing for syscall execution
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The SyscallDispatcher routes syscall names to handler functions using a
 * switch statement. Each syscall receives explicit dependencies (proc, kernel,
 * vfs, ems, hal) rather than using context objects or closures.
 *
 * This design separates syscall orchestration from the kernel's core process
 * and handle management responsibilities. The kernel provides the primitives;
 * the syscall layer orchestrates them.
 *
 * DESIGN PRINCIPLES
 * =================
 * 1. **Switch-based routing**: Explicit case statements for each syscall
 * 2. **Direct dependencies**: Args spread directly to syscall functions
 * 3. **Validation in handlers**: Each syscall validates its own arguments
 * 4. **Yield errors, never throw**: All syscalls yield Response messages
 *
 * STATE MACHINE
 * =============
 * Syscall execution flow:
 *
 *   dispatch(proc, name, args)
 *        |
 *        v
 *   switch(name) ──match──> syscall handler
 *        |                       |
 *        │ no match              │ yields Response*
 *        v                       v
 *   yield error('ENOSYS')    return to caller
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: Every dispatch yields at least one Response
 * INV-2: Unknown syscalls yield ENOSYS error
 * INV-3: EMS syscalls check for EMS availability
 * INV-4: Arguments are passed unchanged to handlers
 *
 * CONCURRENCY MODEL
 * =================
 * Dispatchers run in the kernel's main async context. Multiple syscalls from
 * different processes can execute concurrently at await points within handlers.
 * Each dispatch is independent - they do not share mutable dispatcher state.
 *
 * @module syscall/dispatcher
 */

import type { Kernel } from '@src/kernel/kernel.js';
import type { VFS } from '@src/vfs/index.js';
import type { EMS } from '@src/ems/ems.js';
import type { HAL } from '@src/hal/index.js';
import type { Process, Response } from './types.js';
import { respond } from './types.js';

// VFS syscalls
import { fileOpen, fileClose, fileRead, fileWrite, fileSeek } from './vfs.js';
import { fileStat, fileFstat, fileMkdir, fileUnlink, fileRmdir } from './vfs.js';
import { fileReaddir, fileRename, fileSymlink, fileAccess } from './vfs.js';
import { fileRecv, fileSend } from './vfs.js';
import { fsMount, fsUmount } from './vfs.js';

// Process syscalls
import { procSpawn, procExit, procKill, procWait } from './process.js';
import { procGetpid, procGetppid, procCreate } from './process.js';
import { procGetargs, procGetcwd, procChdir, procGetenv, procSetenv } from './process.js';
import { activationGet, poolStats } from './process.js';

// EMS syscalls
import { emsSelect, emsCreate, emsUpdate, emsDelete, emsRevert, emsExpire } from './ems.js';

// HAL syscalls (network, channel)
import { netConnect } from './hal.js';
import { portCreate, portClose, portRecv, portSend } from './hal.js';
import { channelOpen, channelClose, channelCall, channelStream } from './hal.js';
import { channelPush, channelRecv } from './hal.js';

// Handle/IPC syscalls
import { handleRedirect, handleRestore, handleSend, handleClose } from './handle.js';
import { ipcPipe } from './handle.js';

// Pool/worker syscalls
import { poolLease, workerLoad, workerSend, workerRecv, workerRelease } from './pool.js';

// =============================================================================
// SYSCALL DISPATCHER
// =============================================================================

/**
 * Routes syscalls to handler functions.
 *
 * DESIGN:
 * - Switch statement routes by syscall name
 * - Args are spread directly to syscall functions
 * - Each syscall validates its own arguments
 * - All syscalls yield errors, never throw
 */
export class SyscallDispatcher {
    constructor(
        private readonly kernel: Kernel,
        private readonly vfs: VFS,
        private readonly ems: EMS | undefined,
        private readonly hal: HAL,
    ) {}

    /**
     * Dispatch a syscall from a process.
     *
     * ALGORITHM:
     * 1. Switch on syscall name
     * 2. Route to appropriate handler with explicit dependencies
     * 3. Yield responses from handler
     * 4. For unknown syscalls, yield ENOSYS error
     *
     * @param proc - Calling process
     * @param name - Syscall name (e.g., 'file:open', 'proc:spawn')
     * @param args - Syscall arguments
     */
    async *dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        switch (name) {
            // =================================================================
            // VFS SYSCALLS (file:*)
            // =================================================================

            case 'file:open':
                yield* fileOpen(proc, this.kernel, this.vfs, args[0], args[1]);
                break;

            case 'file:close':
                yield* fileClose(proc, this.kernel, args[0]);
                break;

            case 'file:read':
                yield* fileRead(proc, this.kernel, args[0], args[1]);
                break;

            case 'file:write':
                yield* fileWrite(proc, this.kernel, args[0], args[1]);
                break;

            case 'file:seek':
                yield* fileSeek(proc, this.kernel, args[0], args[1], args[2]);
                break;

            case 'file:stat':
                yield* fileStat(proc, this.vfs, args[0]);
                break;

            case 'file:fstat':
                yield* fileFstat(proc, this.kernel, this.vfs, args[0]);
                break;

            case 'file:mkdir':
                yield* fileMkdir(proc, this.vfs, args[0], args[1]);
                break;

            case 'file:unlink':
                yield* fileUnlink(proc, this.vfs, args[0]);
                break;

            case 'file:rmdir':
                yield* fileRmdir(proc, this.vfs, args[0]);
                break;

            case 'file:readdir':
                yield* fileReaddir(proc, this.vfs, args[0]);
                break;

            case 'file:rename':
                yield* fileRename(proc, this.vfs, args[0], args[1]);
                break;

            case 'file:symlink':
                yield* fileSymlink(proc, this.vfs, args[0], args[1]);
                break;

            case 'file:access':
                yield* fileAccess(proc, this.vfs, args[0], args[1]);
                break;

            case 'file:recv':
                yield* fileRecv(proc, this.kernel, args[0]);
                break;

            case 'file:send':
                yield* fileSend(proc, this.kernel, args[0], args[1]);
                break;

            // =================================================================
            // MOUNT SYSCALLS (fs:*)
            // =================================================================

            case 'fs:mount':
                yield* fsMount(proc, this.kernel, this.vfs, args[0], args[1], args[2]);
                break;

            case 'fs:umount':
                yield* fsUmount(proc, this.kernel, this.vfs, args[0]);
                break;

            // =================================================================
            // PROCESS SYSCALLS (proc:*)
            // =================================================================

            case 'proc:spawn':
                yield* procSpawn(proc, this.kernel, args[0], args[1]);
                break;

            case 'proc:exit':
                yield* procExit(proc, this.kernel, args[0]);
                break;

            case 'proc:kill':
                yield* procKill(proc, this.kernel, args[0], args[1]);
                break;

            case 'proc:wait':
                yield* procWait(proc, this.kernel, args[0], args[1]);
                break;

            case 'proc:getpid':
                yield* procGetpid(proc, this.kernel);
                break;

            case 'proc:getppid':
                yield* procGetppid(proc, this.kernel);
                break;

            case 'proc:create':
                yield* procCreate(proc, this.kernel, args[0]);
                break;

            case 'proc:getargs':
                yield* procGetargs(proc);
                break;

            case 'proc:getcwd':
                yield* procGetcwd(proc);
                break;

            case 'proc:chdir':
                yield* procChdir(proc, this.vfs, args[0]);
                break;

            case 'proc:getenv':
                yield* procGetenv(proc, args[0]);
                break;

            case 'proc:setenv':
                yield* procSetenv(proc, args[0], args[1]);
                break;

            // =================================================================
            // EMS SYSCALLS (ems:*)
            // =================================================================

            case 'ems:select':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsSelect(proc, this.ems, args[0], args[1]);
                break;

            case 'ems:create':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsCreate(proc, this.ems, args[0], args[1]);
                break;

            case 'ems:update':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsUpdate(proc, this.ems, args[0], args[1], args[2]);
                break;

            case 'ems:delete':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsDelete(proc, this.ems, args[0], args[1]);
                break;

            case 'ems:revert':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsRevert(proc, this.ems, args[0], args[1]);
                break;

            case 'ems:expire':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }
                yield* emsExpire(proc, this.ems, args[0], args[1]);
                break;

            // =================================================================
            // NETWORK SYSCALLS (net:*, port:*)
            // =================================================================

            case 'net:connect':
                yield* netConnect(proc, this.kernel, this.hal, args[0], args[1], args[2]);
                break;

            case 'port:create':
                yield* portCreate(proc, this.kernel, args[0], args[1]);
                break;

            case 'port:close':
                yield* portClose(proc, this.kernel, args[0]);
                break;

            case 'port:recv':
                yield* portRecv(proc, this.kernel, args[0]);
                break;

            case 'port:send':
                yield* portSend(proc, this.kernel, args[0], args[1], args[2]);
                break;

            // =================================================================
            // CHANNEL SYSCALLS (channel:*)
            // =================================================================

            case 'channel:open':
                yield* channelOpen(proc, this.kernel, this.hal, args[0], args[1], args[2]);
                break;

            case 'channel:close':
                yield* channelClose(proc, this.kernel, args[0]);
                break;

            case 'channel:call':
                yield* channelCall(proc, this.kernel, args[0], args[1]);
                break;

            case 'channel:stream':
                yield* channelStream(proc, this.kernel, args[0], args[1]);
                break;

            case 'channel:push':
                yield* channelPush(proc, this.kernel, args[0], args[1]);
                break;

            case 'channel:recv':
                yield* channelRecv(proc, this.kernel, args[0]);
                break;

            // =================================================================
            // HANDLE/IPC SYSCALLS (handle:*, ipc:*)
            // =================================================================

            case 'handle:redirect':
                yield* handleRedirect(proc, this.kernel, args[0], args[1]);
                break;

            case 'handle:restore':
                yield* handleRestore(proc, this.kernel, args[0], args[1]);
                break;

            case 'handle:send':
                yield* handleSend(proc, this.kernel, args[0], args[1]);
                break;

            case 'handle:close':
                yield* handleClose(proc, this.kernel, args[0]);
                break;

            case 'ipc:pipe':
                yield* ipcPipe(proc, this.kernel);
                break;

            // =================================================================
            // WORKER POOL SYSCALLS (pool:*, worker:*)
            // =================================================================

            case 'pool:lease':
                yield* poolLease(proc, this.kernel, args[0]);
                break;

            case 'pool:stats':
                // Exception: pool:stats doesn't need proc
                yield* poolStats(this.kernel);
                break;

            case 'worker:load':
                yield* workerLoad(proc, this.kernel, args[0], args[1]);
                break;

            case 'worker:send':
                yield* workerSend(proc, this.kernel, args[0], args[1]);
                break;

            case 'worker:recv':
                yield* workerRecv(proc, this.kernel, args[0]);
                break;

            case 'worker:release':
                yield* workerRelease(proc, this.kernel, args[0]);
                break;

            // =================================================================
            // SERVICE ACTIVATION
            // =================================================================

            case 'activation:get':
                yield* activationGet(proc);
                break;

            // =================================================================
            // UNKNOWN SYSCALL
            // =================================================================

            default:
                yield respond.error('ENOSYS', `Unknown syscall: ${name}`);
        }
    }
}
