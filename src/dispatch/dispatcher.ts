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
import type { Auth } from '@src/auth/index.js';
import type { LLM } from '@src/llm/index.js';
import type { KernelMessage, SyscallRequest } from '@src/kernel/types.js';
import type { Process, Response } from './types.js';
import { respond } from './types.js';

// VFS syscalls
import { fileOpen, fileClose, fileRead, fileWrite, fileAppend, fileSeek } from './syscall/vfs.js';
import { fileStat, fileSetstat, fileFstat, fileMkdir, fileUnlink, fileRmdir } from './syscall/vfs.js';
import { fileReaddir, fileRename, fileSymlink, fileAccess } from './syscall/vfs.js';
import { fileRecv, fileSend } from './syscall/vfs.js';
import { fsMount, fsUmount } from './syscall/vfs.js';

// Process syscalls
import { procSpawn, procExit, procKill, procWait } from './syscall/process.js';
import { procGetpid, procGetppid, procCreate } from './syscall/process.js';
import { procGetargs, procGetcwd, procChdir, procGetenv, procSetenv } from './syscall/process.js';
import { activationGet, poolStats, procTickSubscribe, procTickUnsubscribe, procList } from './syscall/process.js';

// EMS syscalls
import { emsDescribe, emsSelect, emsCreate, emsUpdate, emsDelete, emsRevert, emsExpire, emsImport } from './syscall/ems.js';

// HAL syscalls (network, channel)
import { netConnect } from './syscall/hal.js';
import { portCreate, portClose, portRecv, portSend } from './syscall/hal.js';
import { channelOpen, channelClose, channelCall, channelStream } from './syscall/hal.js';
import { channelPush, channelRecv, channelAccept } from './syscall/hal.js';

// Handle/IPC syscalls
import { handleRedirect, handleRestore, handleSend, handleClose } from './syscall/handle.js';
import { ipcPipe } from './syscall/handle.js';

// Pool/worker syscalls
import { poolLease, workerLoad, workerSend, workerRecv, workerRelease } from './syscall/pool.js';

// Auth syscalls
import { authToken, authWhoami, authLogin, authLogout, authSession, authRegister, authGrant } from './syscall/auth.js';

// LLM syscalls
import { llmComplete, llmStream, llmChat, llmChatStream, llmEmbed, llmModels } from './syscall/llm.js';

// Sigcall management syscalls
import { sigcallRegister, sigcallUnregister, sigcallList } from './syscall/sigcall.js';

// Sigcall registry for routing to userspace
import * as sigcallRegistry from './sigcall/registry.js';
import type { SigcallRegistration } from './sigcall/registry.js';

// Stream controllers
import { SyscallController, SigcallController, StallError } from './stream/index.js';

// =============================================================================
// AUTH GATING CONSTANTS
// =============================================================================

/**
 * Syscalls allowed without authentication.
 *
 * WHY: These syscalls must work for anonymous processes:
 * - auth:login - Authenticate (Phase 1)
 * - auth:token - Authenticate via JWT
 * - auth:register - Create account (Phase 1)
 *
 * All other syscalls require proc.session to be set.
 */
const ALLOW_ANONYMOUS = new Set([
    'auth:login',
    'auth:token',
    'auth:register',
]);

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
/**
 * Pending sigcall tracking for responses from userspace handlers.
 */
interface PendingSigcall {
    /** Response queue for items received before consumer awaits */
    queue: Response[];
    /** True when terminal response received */
    done: boolean;
    /** Resolve function when consumer is waiting */
    waiting: ((response: Response | null) => void) | null;
    /** SigcallController for backpressure */
    controller: SigcallController;
}

export class SyscallDispatcher {
    /**
     * Pending sigcalls awaiting responses from userspace handlers.
     * Key is the sigcall request ID.
     */
    private readonly pendingSigcalls = new Map<string, PendingSigcall>();

    constructor(
        private readonly kernel: Kernel,
        private readonly vfs: VFS,
        private readonly ems: EMS | undefined,
        private readonly hal: HAL,
        private readonly auth: Auth | undefined,
        private readonly llm: LLM | undefined,
    ) {}

    /**
     * Dispatch a syscall from a process.
     *
     * ALGORITHM:
     * 1. Check session expiry (lazy expiration)
     * 2. Check authentication (reject anonymous unless allowed)
     * 3. Switch on syscall name
     * 4. Route to appropriate handler with explicit dependencies
     * 5. Yield responses from handler
     * 6. For unknown syscalls, yield ENOSYS error
     *
     * AUTH GATING:
     * - Syscalls in ALLOW_ANONYMOUS work without authentication
     * - All other syscalls require proc.session to be set
     * - Expired sessions are cleared lazily on each syscall
     *
     * @param proc - Calling process
     * @param name - Syscall name (e.g., 'file:open', 'proc:spawn')
     * @param args - Syscall arguments
     */
    async *dispatch(proc: Process, name: string, args: unknown[]): AsyncIterable<Response> {
        // =====================================================================
        // AUTH GATING
        // =====================================================================

        // Check session expiry (lazy expiration)
        // WHY: Sessions expire based on JWT exp claim. We check on each syscall
        // and clear identity if expired. This avoids background expiration timers.
        if (proc.expires && proc.expires < Date.now()) {
            proc.user = 'anonymous';
            proc.session = undefined;
            proc.expires = undefined;
            proc.sessionValidatedAt = undefined;
            proc.sessionData = undefined;
            // Falls through to anonymous check below
        }

        // Check authentication requirement
        // WHY: Most syscalls require authentication. Only auth:login, auth:token,
        // and auth:register work for anonymous processes.
        const requiresAuth = !ALLOW_ANONYMOUS.has(name);
        const isAuthenticated = proc.session !== undefined;
        const anonymousAllowed = this.auth?.isAnonymousAllowed() ?? true;

        if (requiresAuth && !isAuthenticated && !anonymousAllowed) {
            yield respond.error('EACCES', 'Authentication required');

            return;
        }

        // TODO: Phase 4 - Check proc.sessionData.scope against SYSCALL_SCOPES map.
        // Currently scopes are stored in JWT but not enforced on syscall execution.

        // Periodic session revalidation (Phase 1)
        // WHY: Check EMS to detect revoked sessions. Uses authSession handler
        // so logic stays in auth layer, dispatcher just routes.
        if (this.auth && proc.session && requiresAuth) {
            for await (const response of authSession(proc, this.auth, 'revalidate')) {
                // If session was invalidated, check auth again
                if (response.op === 'ok' && response.data && !(response.data as { valid?: boolean }).valid) {
                    if (!anonymousAllowed) {
                        yield respond.error('EACCES', 'Session expired or revoked');

                        return;
                    }
                }
            }
        }

        // =====================================================================
        // SYSCALL ROUTING
        // =====================================================================

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

            case 'file:append':
                yield* fileAppend(proc, this.kernel, this.vfs, args[0], args[1]);
                break;

            case 'file:seek':
                yield* fileSeek(proc, this.kernel, args[0], args[1], args[2]);
                break;

            case 'file:stat':
                yield* fileStat(proc, this.vfs, args[0]);
                break;

            case 'file:setstat':
                yield* fileSetstat(proc, this.vfs, args[0], args[1]);
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

            case 'proc:tick:subscribe':
                yield* procTickSubscribe(proc, this.kernel);
                break;

            case 'proc:tick:unsubscribe':
                yield* procTickUnsubscribe(proc, this.kernel);
                break;

            case 'proc:list':
                yield* procList(proc, this.kernel);
                break;

                // =================================================================
                // EMS SYSCALLS (ems:*)
                // =================================================================

            case 'ems:describe':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }

                yield* emsDescribe(proc, this.ems, args[0]);
                break;

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

            case 'ems:import':
                if (!this.ems) {
                    yield respond.error('ENOSYS', 'EMS not available');
                    break;
                }

                yield* emsImport(proc, this.ems, args[0], args[1]);
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

            case 'channel:accept':
                yield* channelAccept(proc, this.kernel, this.hal, args[0], args[1], args[2]);
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
                // AUTH SYSCALLS (auth:*)
                // =================================================================

            case 'auth:token':
                if (!this.auth) {
                    yield respond.error('ENOSYS', 'Auth not available');
                    break;
                }

                yield* authToken(proc, this.auth, args[0]);
                break;

            case 'auth:whoami':
                yield* authWhoami(proc);
                break;

            case 'auth:login':
                if (!this.auth) {
                    yield respond.error('ENOSYS', 'Auth not available');
                    break;
                }

                yield* authLogin(proc, this.auth, args[0]);
                break;

            case 'auth:logout':
                if (!this.auth) {
                    yield respond.error('ENOSYS', 'Auth not available');
                    break;
                }

                yield* authLogout(proc, this.auth);
                break;

            case 'auth:register':
                if (!this.auth) {
                    yield respond.error('ENOSYS', 'Auth not available');
                    break;
                }

                yield* authRegister(proc, this.auth, args[0]);
                break;

            case 'auth:grant':
                if (!this.auth) {
                    yield respond.error('ENOSYS', 'Auth not available');
                    break;
                }

                yield* authGrant(proc, this.auth, args[0]);
                break;

                // =================================================================
                // LLM SYSCALLS (llm:*)
                // =================================================================

            case 'llm:complete':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmComplete(proc, this.llm, args[0], args[1], args[2]);
                break;

            case 'llm:stream':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmStream(proc, this.llm, args[0], args[1], args[2]);
                break;

            case 'llm:chat':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmChat(proc, this.llm, args[0], args[1], args[2]);
                break;

            case 'llm:chat:stream':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmChatStream(proc, this.llm, args[0], args[1], args[2]);
                break;

            case 'llm:embed':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmEmbed(proc, this.llm, args[0], args[1]);
                break;

            case 'llm:models':
                if (!this.llm) {
                    yield respond.error('ENOSYS', 'LLM not available');
                    break;
                }

                yield* llmModels(proc, this.llm, args[0]);
                break;

                // =================================================================
                // SIGCALL MANAGEMENT
                // =================================================================

            case 'sigcall:register':
                yield* sigcallRegister(proc, args[0] as string);
                break;

            case 'sigcall:unregister':
                yield* sigcallUnregister(proc, args[0] as string);
                break;

            case 'sigcall:list':
                yield* sigcallList(proc);
                break;

                // =================================================================
                // SIGCALL ROUTING (userspace handlers)
                // =================================================================

            default: {
                // Check if a userspace process has registered a handler
                const registration = sigcallRegistry.lookup(name);

                if (registration) {
                    yield* this.routeToUserspace(proc, registration, name, args);
                }
                else {
                    yield respond.error('ENOSYS', `Unknown syscall: ${name}`);
                }
            }
        }
    }

    /**
     * Execute a syscall with streaming and backpressure.
     *
     * This wraps dispatch() with SyscallController for backpressure management.
     * Called by the kernel's message handler.
     *
     * ALGORITHM:
     * 1. Create SyscallController and register for ping/cancel
     * 2. Call dispatch() to get source iterable
     * 3. Wrap with controller for backpressure
     * 4. For each response, check process state and send to consumer
     * 5. Terminal ops (ok/error/done/redirect) end the stream
     * 6. Clean up ping handler and stream registration on completion
     *
     * @param proc - Calling process
     * @param requestId - Request correlation ID for ping/cancel routing
     * @param name - Syscall name
     * @param args - Syscall arguments
     */
    async *execute(
        proc: Process,
        requestId: string,
        name: string,
        args: unknown[],
    ): AsyncIterable<Response> {
        const controller = new SyscallController();

        // Register for cancellation via stream_cancel message
        proc.activeStreams.set(requestId, controller.abort);

        // Register ping handler (consumer sends stream_ping with items processed)
        // WHY: Ping handler runs when consumer acknowledges items, allowing
        //      backpressure resolution when gap <= LOW_WATER
        proc.streamPingHandlers.set(requestId, (processed: number) => {
            controller.onPing(processed);
        });

        try {
            const source = this.dispatch(proc, name, args);

            for await (const response of controller.wrap(source)) {
                // RACE FIX: Check process state after each await
                // Process may have been killed while handler was yielding
                if (proc.state === 'zombie') {
                    break;
                }

                yield response;

                // Terminal ops end stream
                if (response.op === 'ok' || response.op === 'error' ||
                    response.op === 'done' || response.op === 'redirect') {
                    return;
                }
            }
        }
        catch (err) {
            if (err instanceof StallError) {
                yield respond.error('ETIMEDOUT', err.message);

                return;
            }

            const error = err as Error & { code?: string };

            yield respond.error(error.code ?? 'EIO', error.message);
        }
        finally {
            // WHY: Must remove handlers to prevent memory leaks
            proc.activeStreams.delete(requestId);
            proc.streamPingHandlers.delete(requestId);
        }
    }

    /**
     * Handle message from a worker.
     *
     * This is the main entry point for worker messages. It routes messages to
     * the appropriate handler based on type (syscall, stream_ping, stream_cancel).
     *
     * ALGORITHM:
     * 1. Look up process by pid from message
     * 2. Validate worker ownership (security check)
     * 3. Check process state (skip zombies)
     * 4. Route by message type:
     *    - syscall: execute() and send responses
     *    - stream_ping: call registered ping handler
     *    - stream_cancel: trigger abort controller
     *
     * @param worker - Worker that sent the message
     * @param msg - Message from worker
     */
    async onWorkerMessage(worker: Worker, msg: KernelMessage): Promise<void> {
        // ---------------------------------------------------------------------
        // Look up process by pid
        // ---------------------------------------------------------------------

        let pid: string | undefined;

        if (msg.type === 'syscall:request') {
            pid = (msg as SyscallRequest).pid;
        }
        else if (msg.type === 'syscall:ping' || msg.type === 'syscall:cancel') {
            // Stream messages don't include pid - find process by stream ID
            // WHY: Protocol compatibility - stream messages reference request ID
            for (const proc of this.kernel.processes.all()) {
                if (proc.activeStreams.has(msg.id)) {
                    pid = proc.id;
                    break;
                }
            }
        }

        if (!pid) {
            return;
        }

        const proc = this.kernel.processes.get(pid);

        if (!proc) {
            return;
        }

        // ---------------------------------------------------------------------
        // Validate worker ownership
        // ---------------------------------------------------------------------

        // SECURITY: Verify message came from correct Worker
        if (proc.worker !== worker) {
            if (msg.type === 'syscall:request') {
                this.sendResponse(proc, (msg as SyscallRequest).id, {
                    op: 'error',
                    data: { code: 'EPERM', message: 'Worker mismatch' },
                });
            }

            return;
        }

        // ---------------------------------------------------------------------
        // Check process state
        // ---------------------------------------------------------------------

        // RACE FIX: Skip messages from zombie processes
        if (proc.state === 'zombie') {
            return;
        }

        // ---------------------------------------------------------------------
        // Route by message type
        // ---------------------------------------------------------------------

        switch (msg.type) {
            case 'syscall:request': {
                const request = msg as SyscallRequest;

                // Execute syscall and send responses
                for await (const response of this.execute(proc, request.id, request.name, request.args)) {
                    this.sendResponse(proc, request.id, response);
                }

                break;
            }

            case 'syscall:ping': {
                // Call registered ping handler
                const handler = proc.streamPingHandlers.get(msg.id);

                if (handler) {
                    handler(msg.processed);
                }

                break;
            }

            case 'syscall:cancel': {
                // Trigger abort controller
                const abort = proc.activeStreams.get(msg.id);

                if (abort) {
                    abort.abort();
                    proc.activeStreams.delete(msg.id);
                    proc.streamPingHandlers.delete(msg.id);
                }

                break;
            }

            case 'sigcall:response': {
                // Response from a sigcall handler
                const result = (msg as { id: string; result: Response }).result;

                this.handleSigcallResponse(msg.id, result);
                break;
            }
        }
    }

    /**
     * Send a response to a process via worker.postMessage().
     *
     * SAFETY: Catches errors from postMessage (worker may be terminating).
     *
     * @param proc - Target process
     * @param requestId - Request ID for correlation
     * @param response - Response to send
     */
    private sendResponse(proc: Process, requestId: string, response: Response): void {
        try {
            proc.worker.postMessage({
                type: 'syscall:response',
                id: requestId,
                result: response,
            });
        }
        catch {
            // Expected during worker termination - ignore
        }
    }

    // =========================================================================
    // SIGCALL ROUTING
    // =========================================================================

    /**
     * Route a syscall to a userspace handler (sigcall).
     *
     * When a process invokes a syscall name that's registered in the sigcall
     * registry, we route to the registered handler process instead of a
     * kernel handler.
     *
     * ALGORITHM:
     * 1. Look up target process from registration
     * 2. Validate target is running
     * 3. Generate request ID and create SigcallController
     * 4. Send sigcall:request to target worker
     * 5. Yield responses as they arrive
     * 6. Clean up on completion or error
     *
     * @param caller - Process making the syscall
     * @param reg - Sigcall registration entry
     * @param name - Syscall name
     * @param args - Syscall arguments
     */
    private async *routeToUserspace(
        caller: Process,
        reg: SigcallRegistration,
        name: string,
        args: unknown[],
    ): AsyncIterable<Response> {
        // Find target process
        const target = this.kernel.processes.get(reg.pid);

        if (!target) {
            yield respond.error('ESRCH', `Handler process ${reg.pid} not found`);

            return;
        }

        if (target.state !== 'running') {
            yield respond.error('ESRCH', `Handler process ${reg.pid} not running`);

            return;
        }

        // Generate request ID
        const requestId = crypto.randomUUID();

        // Set up pending sigcall tracking
        const controller = new SigcallController();
        const pending: PendingSigcall = {
            queue: [],
            done: false,
            waiting: null,
            controller,
        };

        this.pendingSigcalls.set(requestId, pending);

        try {
            // Send sigcall request to target worker
            target.worker.postMessage({
                type: 'sigcall:request',
                id: requestId,
                name,
                args,
                caller: { pid: caller.id },
            });

            // Yield responses as they arrive
            while (!pending.done) {
                // Check for queued response
                const queued = pending.queue.shift();

                if (queued) {
                    yield queued;

                    // Check for terminal
                    if (this.isTerminal(queued.op)) {
                        break;
                    }

                    continue;
                }

                // Wait for next response
                const response = await new Promise<Response | null>(resolve => {
                    pending.waiting = resolve;
                });

                if (response === null) {
                    // Cancelled or error
                    break;
                }

                yield response;

                if (this.isTerminal(response.op)) {
                    break;
                }
            }
        }
        finally {
            this.pendingSigcalls.delete(requestId);
        }
    }

    /**
     * Handle a sigcall response from a worker.
     *
     * Called by onWorkerMessage when a sigcall:response is received.
     *
     * @param requestId - Sigcall request ID
     * @param response - Response from handler
     */
    handleSigcallResponse(requestId: string, response: Response): void {
        const pending = this.pendingSigcalls.get(requestId);

        if (!pending) {
            return;
        }

        if (this.isTerminal(response.op)) {
            pending.done = true;
        }

        if (pending.waiting) {
            pending.waiting(response);
            pending.waiting = null;
        }
        else {
            pending.queue.push(response);
        }
    }

    /**
     * Check if a response op is terminal.
     */
    private isTerminal(op: string): boolean {
        return op === 'ok' || op === 'error' || op === 'done' || op === 'redirect';
    }
}
