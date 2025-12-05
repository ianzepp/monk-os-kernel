/**
 * Environment operations for VFS scripts.
 */

import { call } from './syscall';

export function getcwd(): Promise<string> {
    return call<string>('proc:getcwd');
}

export function chdir(path: string): Promise<void> {
    return call<void>('proc:chdir', path);
}

export function getenv(name: string): Promise<string | undefined> {
    return call<string | undefined>('proc:getenv', name);
}

export function setenv(name: string, value: string): Promise<void> {
    return call<void>('proc:setenv', name, value);
}
