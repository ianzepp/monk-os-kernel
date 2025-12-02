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
    ChannelOpts,
    HttpRequest,
    Message,
    Response,
    Grant,
    ACL,
    MkdirOpts,
    SignalHandler,
} from './types';

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

// Pipe operations
export { pipe, redirect } from './pipe';

// Network operations
export { connect, listen, recv, send, pclose } from './net';

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
