import { describe, it, expect, beforeEach } from 'bun:test';
import { BunCryptoDevice } from '@src/hal/index.js';

describe('Crypto Device', () => {
    describe('BunCryptoDevice', () => {
        let crypto: BunCryptoDevice;

        beforeEach(() => {
            crypto = new BunCryptoDevice();
        });

        describe('hash', () => {
            const testData = new TextEncoder().encode('hello world');

            it('should compute SHA-256 hash', async () => {
                const hash = await crypto.hash('sha256', testData);
                expect(hash.length).toBe(32); // 256 bits = 32 bytes
            });

            it('should compute SHA-384 hash', async () => {
                const hash = await crypto.hash('sha384', testData);
                expect(hash.length).toBe(48); // 384 bits = 48 bytes
            });

            it('should compute SHA-512 hash', async () => {
                const hash = await crypto.hash('sha512', testData);
                expect(hash.length).toBe(64); // 512 bits = 64 bytes
            });

            it('should compute SHA-1 hash', async () => {
                const hash = await crypto.hash('sha1', testData);
                expect(hash.length).toBe(20); // 160 bits = 20 bytes
            });

            it('should compute MD5 hash', async () => {
                const hash = await crypto.hash('md5', testData);
                expect(hash.length).toBe(16); // 128 bits = 16 bytes
            });

            it('should produce deterministic output', async () => {
                const hash1 = await crypto.hash('sha256', testData);
                const hash2 = await crypto.hash('sha256', testData);
                expect(hash1).toEqual(hash2);
            });

            it('should produce different output for different input', async () => {
                const hash1 = await crypto.hash('sha256', testData);
                const hash2 = await crypto.hash('sha256', new TextEncoder().encode('different'));
                expect(hash1).not.toEqual(hash2);
            });

            it('should handle empty input', async () => {
                const hash = await crypto.hash('sha256', new Uint8Array(0));
                expect(hash.length).toBe(32);
            });
        });

        describe('hmac', () => {
            const key = new TextEncoder().encode('secret key');
            const data = new TextEncoder().encode('message');

            it('should compute HMAC-SHA256', async () => {
                const mac = await crypto.hmac('sha256', key, data);
                expect(mac.length).toBe(32);
            });

            it('should compute HMAC-SHA512', async () => {
                const mac = await crypto.hmac('sha512', key, data);
                expect(mac.length).toBe(64);
            });

            it('should produce deterministic output', async () => {
                const mac1 = await crypto.hmac('sha256', key, data);
                const mac2 = await crypto.hmac('sha256', key, data);
                expect(mac1).toEqual(mac2);
            });

            it('should produce different output for different key', async () => {
                const mac1 = await crypto.hmac('sha256', key, data);
                const mac2 = await crypto.hmac('sha256', new TextEncoder().encode('other key'), data);
                expect(mac1).not.toEqual(mac2);
            });
        });

        describe('genkey', () => {
            it('should generate AES-256 key', async () => {
                const key = await crypto.genkey('aes-256');
                expect(key).toBeDefined();
                expect(key.algorithm.name).toBe('AES-GCM');
            });

            it('should generate AES-128 key', async () => {
                const key = await crypto.genkey('aes-128');
                expect(key).toBeDefined();
            });

            it('should generate HMAC-SHA256 key', async () => {
                const key = await crypto.genkey('hmac-sha256');
                expect(key).toBeDefined();
                expect(key.algorithm.name).toBe('HMAC');
            });

            it('should generate different keys each time', async () => {
                const key1 = await crypto.genkey('aes-256');
                const key2 = await crypto.genkey('aes-256');

                // Export keys to compare
                const raw1 = await globalThis.crypto.subtle.exportKey('raw', key1);
                const raw2 = await globalThis.crypto.subtle.exportKey('raw', key2);

                expect(new Uint8Array(raw1)).not.toEqual(new Uint8Array(raw2));
            });
        });

        describe('encrypt/decrypt', () => {
            it('should encrypt and decrypt with AES-256-GCM', async () => {
                const key = await crypto.genkey('aes-256');
                const plaintext = new TextEncoder().encode('secret message');

                const ciphertext = await crypto.encrypt('aes-256-gcm', key, plaintext);
                const decrypted = await crypto.decrypt('aes-256-gcm', key, ciphertext);

                expect(decrypted).toEqual(plaintext);
            });

            it('should encrypt and decrypt with AES-128-GCM', async () => {
                const key = await crypto.genkey('aes-128');
                const plaintext = new TextEncoder().encode('secret message');

                const ciphertext = await crypto.encrypt('aes-128-gcm', key, plaintext);
                const decrypted = await crypto.decrypt('aes-128-gcm', key, ciphertext);

                expect(decrypted).toEqual(plaintext);
            });

            it('should produce different ciphertext each time (random IV)', async () => {
                const key = await crypto.genkey('aes-256');
                const plaintext = new TextEncoder().encode('secret');

                const ct1 = await crypto.encrypt('aes-256-gcm', key, plaintext);
                const ct2 = await crypto.encrypt('aes-256-gcm', key, plaintext);

                // Ciphertexts should be different due to random IV
                expect(ct1).not.toEqual(ct2);

                // But both should decrypt correctly
                expect(await crypto.decrypt('aes-256-gcm', key, ct1)).toEqual(plaintext);
                expect(await crypto.decrypt('aes-256-gcm', key, ct2)).toEqual(plaintext);
            });

            it('should fail to decrypt with wrong key', async () => {
                const key1 = await crypto.genkey('aes-256');
                const key2 = await crypto.genkey('aes-256');
                const plaintext = new TextEncoder().encode('secret');

                const ciphertext = await crypto.encrypt('aes-256-gcm', key1, plaintext);

                await expect(crypto.decrypt('aes-256-gcm', key2, ciphertext)).rejects.toThrow();
            });

            it('should handle empty plaintext', async () => {
                const key = await crypto.genkey('aes-256');
                const plaintext = new Uint8Array(0);

                const ciphertext = await crypto.encrypt('aes-256-gcm', key, plaintext);
                const decrypted = await crypto.decrypt('aes-256-gcm', key, ciphertext);

                expect(decrypted).toEqual(plaintext);
            });

            it('should handle large data', async () => {
                const key = await crypto.genkey('aes-256');
                const plaintext = new Uint8Array(1024 * 1024); // 1MB
                globalThis.crypto.getRandomValues(plaintext);

                const ciphertext = await crypto.encrypt('aes-256-gcm', key, plaintext);
                const decrypted = await crypto.decrypt('aes-256-gcm', key, ciphertext);

                expect(decrypted).toEqual(plaintext);
            });
        });

        describe('derive', () => {
            it('should derive key with PBKDF2-SHA256', async () => {
                const password = new TextEncoder().encode('password123');
                const salt = new TextEncoder().encode('random salt');

                const key = await crypto.derive('pbkdf2-sha256', password, salt);
                expect(key.length).toBe(32); // 256 bits
            });

            it('should produce deterministic output for PBKDF2', async () => {
                const password = new TextEncoder().encode('password123');
                const salt = new TextEncoder().encode('same salt');

                const key1 = await crypto.derive('pbkdf2-sha256', password, salt);
                const key2 = await crypto.derive('pbkdf2-sha256', password, salt);

                expect(key1).toEqual(key2);
            });

            it('should produce different output for different salt', async () => {
                const password = new TextEncoder().encode('password123');

                const key1 = await crypto.derive('pbkdf2-sha256', password, new TextEncoder().encode('salt1'));
                const key2 = await crypto.derive('pbkdf2-sha256', password, new TextEncoder().encode('salt2'));

                expect(key1).not.toEqual(key2);
            });

            it('should derive key with Argon2id', async () => {
                const password = new TextEncoder().encode('password123');
                const salt = new TextEncoder().encode('random salt');

                const hash = await crypto.derive('argon2id', password, salt);
                // Argon2 returns a string hash encoded as bytes
                expect(hash.length).toBeGreaterThan(0);
            });
        });

        describe('verify', () => {
            it('should verify correct password', async () => {
                const password = new TextEncoder().encode('password123');
                const hash = await crypto.derive('argon2id', password, new Uint8Array(16));

                const result = await crypto.verify(hash, password);
                expect(result).toBe(true);
            });

            it('should reject incorrect password', async () => {
                const password = new TextEncoder().encode('password123');
                const wrong = new TextEncoder().encode('wrongpassword');
                const hash = await crypto.derive('argon2id', password, new Uint8Array(16));

                const result = await crypto.verify(hash, wrong);
                expect(result).toBe(false);
            });
        });
    });
});
