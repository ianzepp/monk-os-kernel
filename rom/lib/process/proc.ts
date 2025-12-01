/**
 * Process operations for VFS scripts.
 */

import { SpawnOpts, ExitStatus } from './types';
import { call } from './syscall';
import { SIGTERM } from './syscall';

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
