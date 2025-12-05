/**
 * Access control operations for VFS scripts.
 */

import type { ACL } from './types';
import { call } from './syscall';

export function access(path: string): Promise<ACL>;
export function access(path: string, acl: ACL | null): Promise<void>;
export function access(path: string, acl?: ACL | null): Promise<ACL | void> {
    if (acl === undefined) {
        return call<ACL>('file:access', path);
    }

    return call<void>('file:access', path, acl);
}
