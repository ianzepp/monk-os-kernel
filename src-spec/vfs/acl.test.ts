import { describe, it, expect } from 'bun:test';
import {
    checkAccess,
    checkAccessAll,
    defaultACL,
    encodeACL,
    decodeACL,
    MODEL_OPS,
    type ACL,
    type Grant,
} from '@src/vfs/acl.js';

describe('VFS ACL', () => {
    describe('checkAccess', () => {
        it('should deny if caller is in deny list', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read', 'write'] }],
                deny: ['user1'],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(false);
        });

        it('should allow if caller has explicit grant', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read', 'write'] }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(true);
            expect(checkAccess(acl, 'user1', 'write')).toBe(true);
        });

        it('should deny if caller has no grant', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'] }],
                deny: [],
            };
            expect(checkAccess(acl, 'user2', 'read')).toBe(false);
        });

        it('should deny if operation not in grant', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'] }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'write')).toBe(false);
        });

        it('should allow * grant for any operation', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['*'] }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(true);
            expect(checkAccess(acl, 'user1', 'write')).toBe(true);
            expect(checkAccess(acl, 'user1', 'delete')).toBe(true);
            expect(checkAccess(acl, 'user1', 'anything')).toBe(true);
        });

        it('should respect grant expiration', () => {
            const now = 1000;
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'], expires: 500 }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read', now)).toBe(false);
        });

        it('should allow non-expired grants', () => {
            const now = 1000;
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'], expires: 2000 }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read', now)).toBe(true);
        });

        it('should check first matching grant', () => {
            const acl: ACL = {
                grants: [
                    { to: 'user1', ops: ['read'] },
                    { to: 'user1', ops: ['write'] },
                ],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(true);
            expect(checkAccess(acl, 'user1', 'write')).toBe(true);
        });

        it('should handle empty grants', () => {
            const acl: ACL = {
                grants: [],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(false);
        });

        it('should handle empty deny', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'] }],
                deny: [],
            };
            expect(checkAccess(acl, 'user1', 'read')).toBe(true);
        });
    });

    describe('checkAccessAll', () => {
        it('should return true if all operations permitted', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read', 'write', 'delete'] }],
                deny: [],
            };
            expect(checkAccessAll(acl, 'user1', ['read', 'write'])).toBe(true);
        });

        it('should return false if any operation not permitted', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'] }],
                deny: [],
            };
            expect(checkAccessAll(acl, 'user1', ['read', 'write'])).toBe(false);
        });

        it('should return true for empty operations array', () => {
            const acl: ACL = {
                grants: [],
                deny: [],
            };
            expect(checkAccessAll(acl, 'user1', [])).toBe(true);
        });
    });

    describe('defaultACL', () => {
        it('should grant * to creator', () => {
            const acl = defaultACL('creator-uuid');
            expect(acl.grants.length).toBe(1);
            expect(acl.grants[0].to).toBe('creator-uuid');
            expect(acl.grants[0].ops).toContain('*');
        });

        it('should have empty deny list', () => {
            const acl = defaultACL('creator-uuid');
            expect(acl.deny).toEqual([]);
        });

        it('should allow any operation for creator', () => {
            const acl = defaultACL('creator-uuid');
            expect(checkAccess(acl, 'creator-uuid', 'read')).toBe(true);
            expect(checkAccess(acl, 'creator-uuid', 'write')).toBe(true);
            expect(checkAccess(acl, 'creator-uuid', 'delete')).toBe(true);
            expect(checkAccess(acl, 'creator-uuid', 'anything')).toBe(true);
        });

        it('should deny others', () => {
            const acl = defaultACL('creator-uuid');
            expect(checkAccess(acl, 'other-uuid', 'read')).toBe(false);
        });
    });

    describe('encodeACL/decodeACL', () => {
        it('should round-trip ACL', () => {
            const acl: ACL = {
                grants: [
                    { to: 'user1', ops: ['read', 'write'] },
                    { to: 'user2', ops: ['read'], expires: 9999 },
                ],
                deny: ['user3', 'user4'],
            };

            const encoded = encodeACL(acl);
            const decoded = decodeACL(encoded);

            expect(decoded).toEqual(acl);
        });

        it('should produce valid JSON bytes', () => {
            const acl: ACL = {
                grants: [{ to: 'user1', ops: ['read'] }],
                deny: [],
            };

            const encoded = encodeACL(acl);
            const json = new TextDecoder().decode(encoded);

            expect(() => JSON.parse(json)).not.toThrow();
        });

        it('should handle empty ACL', () => {
            const acl: ACL = {
                grants: [],
                deny: [],
            };

            const decoded = decodeACL(encodeACL(acl));
            expect(decoded).toEqual(acl);
        });
    });

    describe('MODEL_OPS', () => {
        it('should define file operations', () => {
            expect(MODEL_OPS.file).toContain('read');
            expect(MODEL_OPS.file).toContain('write');
            expect(MODEL_OPS.file).toContain('delete');
            expect(MODEL_OPS.file).toContain('stat');
            expect(MODEL_OPS.file).toContain('*');
        });

        it('should define folder operations', () => {
            expect(MODEL_OPS.folder).toContain('list');
            expect(MODEL_OPS.folder).toContain('create');
            expect(MODEL_OPS.folder).toContain('delete');
            expect(MODEL_OPS.folder).toContain('stat');
            expect(MODEL_OPS.folder).toContain('*');
        });

        it('should define network operations', () => {
            expect(MODEL_OPS.network).toContain('connect');
            expect(MODEL_OPS.network).toContain('listen');
        });

        it('should define device operations', () => {
            expect(MODEL_OPS.device).toContain('read');
            expect(MODEL_OPS.device).toContain('write');
        });

        it('should define proc operations', () => {
            expect(MODEL_OPS.proc).toContain('signal');
            expect(MODEL_OPS.proc).toContain('stat');
        });
    });
});
