/**
 * Process operations for VFS scripts.
 */

import type { SpawnOpts, ExitStatus, Message } from './types';
import { call, SIGTERM } from './syscall';

export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return call<number>('spawn', entry, opts);
}

export function exit(code: number): Promise<never> {
    return call<never>('exit', code);
}

export function kill(pid: number, signal?: number): Promise<void> {
    return call<void>('kill', pid, signal ?? SIGTERM);
}

export function wait(pid: number): Promise<ExitStatus> {
    return call<ExitStatus>('wait', pid);
}

export function getpid(): Promise<number> {
    return call<number>('getpid');
}

export function getppid(): Promise<number> {
    return call<number>('getppid');
}

export function getargs(): Promise<string[]> {
    return call<string[]>('getargs');
}

/**
 * Get the activation message for this service handler.
 * Returns null for boot-activated services or regular processes.
 */
export function getActivation(): Promise<Message | null> {
    return call<Message | null>('activation:get');
}
