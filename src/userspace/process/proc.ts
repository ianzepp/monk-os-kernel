/**
 * Process operations for VFS scripts.
 */

import type { SpawnOpts, ExitStatus, Message } from './types';
import { call, SIGTERM } from './syscall';

export function spawn(entry: string, opts?: SpawnOpts): Promise<number> {
    return call<number>('proc:spawn', entry, opts);
}

export function exit(code: number): Promise<never> {
    return call<never>('proc:exit', code);
}

export function kill(pid: number, signal?: number): Promise<void> {
    return call<void>('proc:kill', pid, signal ?? SIGTERM);
}

export function wait(pid: number): Promise<ExitStatus> {
    return call<ExitStatus>('proc:wait', pid);
}

export function getpid(): Promise<number> {
    return call<number>('proc:getpid');
}

export function getppid(): Promise<number> {
    return call<number>('proc:getppid');
}

export function getargs(): Promise<string[]> {
    return call<string[]>('proc:getargs');
}

/**
 * Get the activation message for this service handler.
 * Returns null for boot-activated services or regular processes.
 */
export function getActivation(): Promise<Message | null> {
    return call<Message | null>('activation:get');
}
