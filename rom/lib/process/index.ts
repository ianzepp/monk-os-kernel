/**
 * Process Library for VFS Scripts
 *
 * Re-exports all process-related modules.
 */

// Types
export type {
    OpenFlags,
    SeekWhence,
    Stat,
    SpawnOpts,
    ExitStatus,
    PortMessage,
    TcpListenOpts,
    WatchOpts,
    UdpOpts,
    PubsubOpts,
    PoolStats,
    ChannelOpts,
    HttpRequest,
    Message,
    Response,
    Grant,
    ACL,
    MkdirOpts,
    SignalHandler,
} from './types';

// Response helper
export { respond } from './types';

// Error
export { SyscallError } from './error';

// Syscall transport (advanced use)
export { syscall, call, collect, iterate, SIGTERM, SIGKILL, onSignal } from './syscall';

// File operations
export { open, close, read, readAll, readLines, readText, write, seek, stat, fstat } from './file';

// Directory operations
export { mkdir, unlink, rmdir, readdir, readdirAll, rename, symlink } from './dir';

// Access control
export { access } from './access';

// Pipe operations (message-based I/O)
export { pipe, redirect, recv, send } from './pipe';

// Redirect operations (message↔byte boundary for shell redirects)
export { outputRedirect, inputRedirect } from './redirect';
export type { RedirectHandle } from './redirect';

// Network operations
export { connect, unix, listen, watch, udp, pubsub, portRecv, portSend, pclose } from './net';

// Worker pool operations
export { pool, worker } from './worker';

// Channel operations
export { channel, httpRequest, sqlQuery, sqlExecute } from './channel';

// Process operations
export { spawn, exit, kill, wait, getpid, getppid, getargs, getActivation } from './proc';

// Environment operations
export { getcwd, chdir, getenv, setenv } from './env';

// Convenience I/O
export { readFile, readFileBytes, writeFile, copy, copyFile, print, println, eprint, eprintln, sleep } from './io';

// Head operations
export { head, headLines, headFile, headFileLines } from './head';

// Tail operations
export { tail, tailLines, tailFile, tailFileLines } from './tail';
