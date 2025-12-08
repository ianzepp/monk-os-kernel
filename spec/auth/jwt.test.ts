/**
 * JWT Implementation Tests
 *
 * Tests for JWT signing and verification.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { signJWT, verifyJWT, generateKey } from '@src/auth/jwt.js';
import type { JWTPayload } from '@src/auth/types.js';

describe('JWT', () => {
    let key: Uint8Array;

    beforeEach(() => {
        key = generateKey(32);
    });

    describe('generateKey', () => {
        it('should generate a key of the specified size', () => {
            const key16 = generateKey(16);
            const key32 = generateKey(32);
            const key64 = generateKey(64);

            expect(key16.length).toBe(16);
            expect(key32.length).toBe(32);
            expect(key64.length).toBe(64);
        });

        it('should generate different keys each time', () => {
            const key1 = generateKey(32);
            const key2 = generateKey(32);

            // Keys should be different (with overwhelming probability)
            expect(Buffer.from(key1).equals(Buffer.from(key2))).toBe(false);
        });
    });

    describe('signJWT', () => {
        it('should produce a valid JWT format (3 dot-separated parts)', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
            };

            const token = await signJWT(payload, key);
            const parts = token.split('.');

            expect(parts.length).toBe(3);
            // Each part should be non-empty
            expect(parts[0]!.length).toBeGreaterThan(0);
            expect(parts[1]!.length).toBeGreaterThan(0);
            expect(parts[2]!.length).toBeGreaterThan(0);
        });

        it('should use HS256 algorithm in header', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
            };

            const token = await signJWT(payload, key);
            const [header] = token.split('.');

            // Decode header
            const headerJson = atob(header!.replace(/-/g, '+').replace(/_/g, '/'));
            const headerObj = JSON.parse(headerJson);

            expect(headerObj.alg).toBe('HS256');
            expect(headerObj.typ).toBe('JWT');
        });

        it('should include all payload claims', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: 1234567890,
                exp: 1234657890,
                scope: ['read', 'write'],
            };

            const token = await signJWT(payload, key);
            const [, payloadPart] = token.split('.');

            // Decode payload
            let base64 = payloadPart!.replace(/-/g, '+').replace(/_/g, '/');
            const padding = base64.length % 4;

            if (padding === 2) base64 += '==';
            else if (padding === 3) base64 += '=';

            const payloadJson = atob(base64);
            const payloadObj = JSON.parse(payloadJson);

            expect(payloadObj.sub).toBe('user-123');
            expect(payloadObj.sid).toBe('session-456');
            expect(payloadObj.iat).toBe(1234567890);
            expect(payloadObj.exp).toBe(1234657890);
            expect(payloadObj.scope).toEqual(['read', 'write']);
        });
    });

    describe('verifyJWT', () => {
        it('should verify and decode a valid token', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
            };

            const token = await signJWT(payload, key);
            const decoded = await verifyJWT(token, key);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe('user-123');
            expect(decoded!.sid).toBe('session-456');
        });

        it('should return null for invalid signature', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
            };

            const token = await signJWT(payload, key);

            // Use different key for verification
            const differentKey = generateKey(32);
            const decoded = await verifyJWT(token, differentKey);

            expect(decoded).toBeNull();
        });

        it('should return null for tampered payload', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
            };

            const token = await signJWT(payload, key);
            const [header, , signature] = token.split('.');

            // Create different payload
            const tamperedPayload = { sub: 'hacker', sid: 'evil', iat: 0 };
            const tamperedPayloadB64 = btoa(JSON.stringify(tamperedPayload))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const tamperedToken = `${header}.${tamperedPayloadB64}.${signature}`;
            const decoded = await verifyJWT(tamperedToken, key);

            expect(decoded).toBeNull();
        });

        it('should return null for expired token', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
                exp: Math.floor(Date.now() / 1000) - 1800, // 30 mins ago (expired)
            };

            const token = await signJWT(payload, key);
            const decoded = await verifyJWT(token, key);

            expect(decoded).toBeNull();
        });

        it('should verify token without expiry', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
                // No exp - should never expire
            };

            const token = await signJWT(payload, key);
            const decoded = await verifyJWT(token, key);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe('user-123');
        });

        it('should verify token with future expiry', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
            };

            const token = await signJWT(payload, key);
            const decoded = await verifyJWT(token, key);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe('user-123');
            expect(decoded!.exp).toBe(payload.exp);
        });

        it('should return null for malformed token (wrong number of parts)', async () => {
            const decoded1 = await verifyJWT('invalid', key);
            const decoded2 = await verifyJWT('part1.part2', key);
            const decoded3 = await verifyJWT('part1.part2.part3.part4', key);

            expect(decoded1).toBeNull();
            expect(decoded2).toBeNull();
            expect(decoded3).toBeNull();
        });

        it('should return null for invalid base64 in payload', async () => {
            const decoded = await verifyJWT('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.!!!invalid!!!.signature', key);

            expect(decoded).toBeNull();
        });

        it('should return null for missing required claims', async () => {
            // Create a token manually without required claims
            const headerB64 = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
            const payloadNoSub = btoa(JSON.stringify({ sid: 'session', iat: 123 }))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            // Sign with HMAC
            const signingInput = `${headerB64}.${payloadNoSub}`;
            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                key,
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign'],
            );
            const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(signingInput));
            const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const tokenNoSub = `${headerB64}.${payloadNoSub}.${signatureB64}`;
            const decoded = await verifyJWT(tokenNoSub, key);

            expect(decoded).toBeNull();
        });
    });

    describe('round-trip', () => {
        it('should preserve all claims through sign/verify cycle', async () => {
            const payload: JWTPayload = {
                sub: 'user-123',
                sid: 'session-456',
                iat: 1234567890,
                exp: 9999999999, // Far future
                scope: ['read', 'write'],
                custom: { nested: 'value' },
            };

            const token = await signJWT(payload, key);
            const decoded = await verifyJWT(token, key);

            expect(decoded).not.toBeNull();
            expect(decoded!.sub).toBe(payload.sub);
            expect(decoded!.sid).toBe(payload.sid);
            expect(decoded!.iat).toBe(payload.iat);
            expect(decoded!.exp).toBe(payload.exp);
            expect(decoded!.scope).toEqual(payload.scope);
            expect(decoded!.custom).toEqual(payload.custom);
        });
    });
});
