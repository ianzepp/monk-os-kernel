/**
 * Kernel Module
 *
 * Monk OS kernel - process management, syscall dispatch, and coordination.
 */

// Core kernel
export { Kernel } from '@src/kernel/kernel.js';

// Process management
export { ProcessTable } from '@src/kernel/process-table.js';

// Syscall dispatch
export {
    SyscallDispatcher,
    createFileSyscalls,
    createMiscSyscalls,
    createNetworkSyscalls,
} from '@src/kernel/syscalls.js';
export type { SyscallHandler, SyscallRegistry } from '@src/kernel/syscalls.js';

// Resources
export type { Resource, ResourceType } from '@src/kernel/resource.js';
export { FileResource, SocketResource } from '@src/kernel/resource.js';

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
    Stat,
    OpenFlags,
    SeekWhence,
    PortType,
    PortOpts,
    PortMessage,
    BootEnv,
} from '@src/kernel/types.js';

export {
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
