/**
 * Kernel Module
 *
 * Monk OS kernel - process management and coordination.
 * Syscall dispatch is handled by the syscall layer (src/syscall/).
 */

// Core kernel
export { Kernel } from '@src/kernel/kernel.js';

// Process management
export { ProcessTable } from '@src/kernel/process-table.js';

// Types
export type {
    Process,
    ProcessState,
    SpawnOpts,
    ExitStatus,
    SyscallRequest,
    SyscallResponse,
    SignalMessage,
    KernelMessage,
    ProcessPortMessage,
    Stat,
    OpenFlags,
    SeekWhence,
    PortType,
    PortOpts,
    PortMessage,
    BootEnv,
} from '@src/kernel/types.js';

export {
    KERNEL_ID,
    SIGTERM,
    SIGKILL,
    TERM_GRACE_MS,
} from '@src/kernel/types.js';

// Errors
export {
    ENOSYS,
    ECHILD,
    ESRCH,
    ProcessExited,
    EBADF,
    EINVAL,
    EPERM,
} from '@src/kernel/errors.js';

// Services
export type {
    ServiceDef,
    Activation,
    ActivationType,
    TcpActivation,
    UdpActivation,
    PubsubActivation,
    WatchActivation,
    BootActivation,
    HandlerEntry,
} from '@src/kernel/services.js';

// Worker Pools
export { PoolManager, WorkerPool } from '@src/kernel/pool.js';
export type { PoolConfig, LeasedWorker } from '@src/kernel/pool.js';

// Utilities
export { poll } from '@src/kernel/poll.js';
export type { PollOptions } from '@src/kernel/poll.js';
