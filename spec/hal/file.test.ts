import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BunFileDevice, MockFileDevice } from '@src/hal/file.js';
import { ENOENT } from '@src/hal/errors.js';

describe('FileDevice', () => {
    // =========================================================================
    // BUN FILE DEVICE
    // =========================================================================

    describe('BunFileDevice', () => {
        let tempDir: string;
        let device: BunFileDevice;

        beforeAll(async () => {
            // Create temp directory for test files
            tempDir = await mkdtemp(join(tmpdir(), 'monk-file-test-'));
            device = new BunFileDevice();
        });

        afterAll(async () => {
            // Clean up temp directory
            await rm(tempDir, { recursive: true, force: true });
        });

        // ---------------------------------------------------------------------
        // read()
        // ---------------------------------------------------------------------

        describe('read()', () => {
            it('should read file as bytes', async () => {
                const path = join(tempDir, 'test-bytes.bin');
                const content = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

                await fsWriteFile(path, content);

                const result = await device.read(path);

                expect(result).toBeInstanceOf(Uint8Array);
                expect(result).toEqual(content);
            });

            it('should read empty file', async () => {
                const path = join(tempDir, 'empty.bin');

                await fsWriteFile(path, new Uint8Array(0));

                const result = await device.read(path);

                expect(result).toBeInstanceOf(Uint8Array);
                expect(result.length).toBe(0);
            });

            it('should read binary file with all byte values', async () => {
                const path = join(tempDir, 'all-bytes.bin');
                const content = new Uint8Array(256);

                for (let i = 0; i < 256; i++) {
                    content[i] = i;
                }

                await fsWriteFile(path, content);

                const result = await device.read(path);

                expect(result).toEqual(content);
            });

            it('should throw ENOENT for missing file', async () => {
                const path = join(tempDir, 'nonexistent.bin');

                try {
                    await device.read(path);
                    expect(true).toBe(false); // Should not reach here
                }
                catch (err) {
                    expect(err).toBeInstanceOf(ENOENT);
                    expect((err as ENOENT).message).toContain('File not found');
                    expect((err as ENOENT).message).toContain(path);
                }
            });

            it('should read large file', async () => {
                const path = join(tempDir, 'large.bin');
                // 1MB file
                const content = new Uint8Array(1024 * 1024);

                for (let i = 0; i < content.length; i++) {
                    content[i] = i % 256;
                }

                await fsWriteFile(path, content);

                const result = await device.read(path);

                expect(result.length).toBe(content.length);
                expect(result[0]).toBe(0);
                expect(result[1024]).toBe(0); // 1024 % 256 = 0
                expect(result[content.length - 1]).toBe(255);
            });
        });

        // ---------------------------------------------------------------------
        // readText()
        // ---------------------------------------------------------------------

        describe('readText()', () => {
            it('should read file as UTF-8 text', async () => {
                const path = join(tempDir, 'test.txt');
                const content = 'Hello, World!';

                await fsWriteFile(path, content, 'utf8');

                const result = await device.readText(path);

                expect(typeof result).toBe('string');
                expect(result).toBe(content);
            });

            it('should read file with Unicode characters', async () => {
                const path = join(tempDir, 'unicode.txt');
                const content = '日本語テスト 🎉 émojis и кириллица';

                await fsWriteFile(path, content, 'utf8');

                const result = await device.readText(path);

                expect(result).toBe(content);
            });

            it('should read empty text file', async () => {
                const path = join(tempDir, 'empty.txt');

                await fsWriteFile(path, '', 'utf8');

                const result = await device.readText(path);

                expect(result).toBe('');
            });

            it('should read file with newlines', async () => {
                const path = join(tempDir, 'newlines.txt');
                const content = 'line1\nline2\r\nline3\rline4';

                await fsWriteFile(path, content, 'utf8');

                const result = await device.readText(path);

                expect(result).toBe(content);
            });

            it('should throw ENOENT for missing file', async () => {
                const path = join(tempDir, 'nonexistent.txt');

                try {
                    await device.readText(path);
                    expect(true).toBe(false); // Should not reach here
                }
                catch (err) {
                    expect(err).toBeInstanceOf(ENOENT);
                    expect((err as ENOENT).message).toContain('File not found');
                }
            });

            it('should read JSON file', async () => {
                const path = join(tempDir, 'config.json');
                const data = { name: 'test', value: 42, nested: { a: 1 } };

                await fsWriteFile(path, JSON.stringify(data), 'utf8');

                const result = await device.readText(path);
                const parsed = JSON.parse(result);

                expect(parsed).toEqual(data);
            });

            it('should read SQL schema file', async () => {
                const path = join(tempDir, 'schema.sql');
                const content = `
                    CREATE TABLE users (
                        id INTEGER PRIMARY KEY,
                        name TEXT NOT NULL,
                        email TEXT UNIQUE
                    );

                    CREATE INDEX idx_users_email ON users(email);
                `;

                await fsWriteFile(path, content, 'utf8');

                const result = await device.readText(path);

                expect(result).toBe(content);
                expect(result).toContain('CREATE TABLE');
                expect(result).toContain('CREATE INDEX');
            });
        });

        // ---------------------------------------------------------------------
        // stat()
        // ---------------------------------------------------------------------

        describe('stat()', () => {
            it('should return exists=true and size for existing file', async () => {
                const path = join(tempDir, 'stat-test.txt');
                const content = 'Hello, World!'; // 13 bytes

                await fsWriteFile(path, content, 'utf8');

                const result = await device.stat(path);

                expect(result.exists).toBe(true);
                expect(result.size).toBe(13);
            });

            it('should return exists=false for missing file', async () => {
                const path = join(tempDir, 'nonexistent-stat.txt');

                const result = await device.stat(path);

                expect(result.exists).toBe(false);
                expect(result.size).toBe(0);
            });

            it('should return size=0 for empty file', async () => {
                const path = join(tempDir, 'empty-stat.txt');

                await fsWriteFile(path, '', 'utf8');

                const result = await device.stat(path);

                expect(result.exists).toBe(true);
                expect(result.size).toBe(0);
            });

            it('should return correct size for binary file', async () => {
                const path = join(tempDir, 'binary-stat.bin');
                const content = new Uint8Array(1000);

                await fsWriteFile(path, content);

                const result = await device.stat(path);

                expect(result.exists).toBe(true);
                expect(result.size).toBe(1000);
            });

            it('should return correct size for Unicode file', async () => {
                const path = join(tempDir, 'unicode-stat.txt');
                const content = '日本語'; // 3 characters, 9 bytes in UTF-8

                await fsWriteFile(path, content, 'utf8');

                const result = await device.stat(path);

                expect(result.exists).toBe(true);
                expect(result.size).toBe(9);
            });
        });
    });

    // =========================================================================
    // MOCK FILE DEVICE
    // =========================================================================

    describe('MockFileDevice', () => {
        // ---------------------------------------------------------------------
        // Setup and state
        // ---------------------------------------------------------------------

        describe('setup and state', () => {
            it('should start with no files', async () => {
                const device = new MockFileDevice();

                const result = await device.stat('/test.txt');

                expect(result.exists).toBe(false);
            });

            it('should allow setting file content as bytes', async () => {
                const device = new MockFileDevice();
                const content = new Uint8Array([1, 2, 3, 4, 5]);

                device.setFile('/test.bin', content);

                const result = await device.read('/test.bin');

                expect(result).toEqual(content);
            });

            it('should allow setting file content as text', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/test.txt', 'Hello, World!');

                const result = await device.readText('/test.txt');

                expect(result).toBe('Hello, World!');
            });

            it('should allow clearing all files', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/a.txt', 'a');
                device.setTextFile('/b.txt', 'b');

                expect((await device.stat('/a.txt')).exists).toBe(true);
                expect((await device.stat('/b.txt')).exists).toBe(true);

                device.clear();

                expect((await device.stat('/a.txt')).exists).toBe(false);
                expect((await device.stat('/b.txt')).exists).toBe(false);
            });

            it('should allow overwriting files', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/test.txt', 'original');
                expect(await device.readText('/test.txt')).toBe('original');

                device.setTextFile('/test.txt', 'updated');
                expect(await device.readText('/test.txt')).toBe('updated');
            });
        });

        // ---------------------------------------------------------------------
        // read()
        // ---------------------------------------------------------------------

        describe('read()', () => {
            it('should read file as bytes', async () => {
                const device = new MockFileDevice();
                const content = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);

                device.setFile('/test.bin', content);

                const result = await device.read('/test.bin');

                expect(result).toEqual(content);
            });

            it('should return a copy (not reference)', async () => {
                const device = new MockFileDevice();
                const content = new Uint8Array([1, 2, 3]);

                device.setFile('/test.bin', content);

                const result = await device.read('/test.bin');

                // Modify result
                result[0] = 99;

                // Original should be unchanged
                const result2 = await device.read('/test.bin');

                expect(result2[0]).toBe(1);
            });

            it('should throw ENOENT for missing file', async () => {
                const device = new MockFileDevice();

                try {
                    await device.read('/nonexistent.bin');
                    expect(true).toBe(false);
                }
                catch (err) {
                    expect(err).toBeInstanceOf(ENOENT);
                    expect((err as ENOENT).message).toContain('File not found');
                }
            });
        });

        // ---------------------------------------------------------------------
        // readText()
        // ---------------------------------------------------------------------

        describe('readText()', () => {
            it('should read file as UTF-8 text', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/test.txt', 'Hello!');

                const result = await device.readText('/test.txt');

                expect(result).toBe('Hello!');
            });

            it('should handle Unicode', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/unicode.txt', '日本語 🎉');

                const result = await device.readText('/unicode.txt');

                expect(result).toBe('日本語 🎉');
            });

            it('should throw ENOENT for missing file', async () => {
                const device = new MockFileDevice();

                try {
                    await device.readText('/nonexistent.txt');
                    expect(true).toBe(false);
                }
                catch (err) {
                    expect(err).toBeInstanceOf(ENOENT);
                }
            });

            it('should work with files set via setFile()', async () => {
                const device = new MockFileDevice();
                const content = new TextEncoder().encode('From bytes');

                device.setFile('/test.txt', content);

                const result = await device.readText('/test.txt');

                expect(result).toBe('From bytes');
            });
        });

        // ---------------------------------------------------------------------
        // stat()
        // ---------------------------------------------------------------------

        describe('stat()', () => {
            it('should return exists=true and size for set file', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/test.txt', 'Hello'); // 5 bytes

                const result = await device.stat('/test.txt');

                expect(result.exists).toBe(true);
                expect(result.size).toBe(5);
            });

            it('should return exists=false for missing file', async () => {
                const device = new MockFileDevice();

                const result = await device.stat('/nonexistent.txt');

                expect(result.exists).toBe(false);
                expect(result.size).toBe(0);
            });

            it('should return correct size for binary file', async () => {
                const device = new MockFileDevice();
                const content = new Uint8Array(100);

                device.setFile('/test.bin', content);

                const result = await device.stat('/test.bin');

                expect(result.exists).toBe(true);
                expect(result.size).toBe(100);
            });

            it('should return correct size for Unicode text', async () => {
                const device = new MockFileDevice();

                // '日本語' = 9 bytes in UTF-8
                device.setTextFile('/unicode.txt', '日本語');

                const result = await device.stat('/unicode.txt');

                expect(result.exists).toBe(true);
                expect(result.size).toBe(9);
            });
        });

        // ---------------------------------------------------------------------
        // Use cases
        // ---------------------------------------------------------------------

        describe('use cases', () => {
            it('should work for mocking SQL schema loading', async () => {
                const device = new MockFileDevice();
                const schema = 'CREATE TABLE test (id INTEGER PRIMARY KEY);';

                device.setTextFile('/etc/schema.sql', schema);

                const result = await device.readText('/etc/schema.sql');

                expect(result).toBe(schema);
            });

            it('should work for mocking config file loading', async () => {
                const device = new MockFileDevice();
                const config = JSON.stringify({ database: 'test.db', debug: true });

                device.setTextFile('/etc/config.json', config);

                const result = await device.readText('/etc/config.json');
                const parsed = JSON.parse(result);

                expect(parsed.database).toBe('test.db');
                expect(parsed.debug).toBe(true);
            });

            it('should support multiple files', async () => {
                const device = new MockFileDevice();

                device.setTextFile('/etc/hosts', '127.0.0.1 localhost');
                device.setTextFile('/etc/passwd', 'root:x:0:0:root:/root:/bin/bash');
                device.setTextFile('/etc/resolv.conf', 'nameserver 8.8.8.8');

                expect(await device.readText('/etc/hosts')).toContain('localhost');
                expect(await device.readText('/etc/passwd')).toContain('root');
                expect(await device.readText('/etc/resolv.conf')).toContain('8.8.8.8');
            });
        });
    });
});
