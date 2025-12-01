/**
 * Access control operations for VFS scripts.
 */

import { ACL } from './types';
import { call } from './syscall';

export function access(path: string): Promise<ACL>;
export function access(path: string, acl: ACL | null): Promise<void>;
export function access(path: string, acl?: ACL | null): Promise<ACL | void> {
    if (acl === undefined) {
        return call<ACL>('access', path);
    }
    return call<void>('access', path, acl);
}
