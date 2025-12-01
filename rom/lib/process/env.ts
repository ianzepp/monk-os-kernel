/**
 * Environment operations for VFS scripts.
 */

import { call } from './syscall';

export function getcwd(): Promise<string> {
    return call<string>('getcwd');
}

export function chdir(path: string): Promise<void> {
    return call<void>('chdir', path);
}

export function getenv(name: string): Promise<string | undefined> {
    return call<string | undefined>('getenv', name);
}

export function setenv(name: string, value: string): Promise<void> {
    return call<void>('setenv', name, value);
}
