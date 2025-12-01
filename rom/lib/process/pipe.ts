/**
 * Pipe operations for VFS scripts.
 */

import { call } from './syscall';

export function pipe(): Promise<[number, number]> {
    return call<[number, number]>('pipe');
}

export async function redirect(targetFd: number, sourceFd: number): Promise<() => Promise<void>> {
    const saved = await call<string>('redirect', { target: targetFd, source: sourceFd });

    return async () => {
        await call('restore', { target: targetFd, saved });
    };
}
