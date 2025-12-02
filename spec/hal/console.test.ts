import { describe, it, expect, beforeEach } from 'bun:test';
import { BufferConsoleDevice, BunConsoleDevice } from '@src/hal/index.js';

describe('Console Device', () => {
    describe('BufferConsoleDevice', () => {
        let console: BufferConsoleDevice;

        beforeEach(() => {
            console = new BufferConsoleDevice();
        });

        describe('write', () => {
            it('should capture output', () => {
                const data = new TextEncoder().encode('hello');
                console.write(data);

                expect(console.getOutput()).toBe('hello');
            });

            it('should append multiple writes', () => {
                console.write(new TextEncoder().encode('hello '));
                console.write(new TextEncoder().encode('world'));

                expect(console.getOutput()).toBe('hello world');
            });
        });

        describe('error', () => {
            it('should capture stderr separately', () => {
                console.write(new TextEncoder().encode('stdout'));
                console.error(new TextEncoder().encode('stderr'));

                expect(console.getOutput()).toBe('stdout');
                expect(console.getErrors()).toBe('stderr');
            });
        });

        describe('read', () => {
            it('should return set input', async () => {
                console.setInput('test input');
                const data = await console.read();
                expect(new TextDecoder().decode(data)).toBe('test input');
            });

            it('should return empty after input consumed', async () => {
                console.setInput('test');
                await console.read();
                const data = await console.read();
                expect(data.length).toBe(0);
            });
        });

        describe('readline', () => {
            it('should read single line', async () => {
                console.setInput('line1\nline2\n');
                expect(await console.readline()).toBe('line1');
                expect(await console.readline()).toBe('line2');
            });

            it('should handle Windows line endings', async () => {
                console.setInput('line1\r\nline2\r\n');
                expect(await console.readline()).toBe('line1');
                expect(await console.readline()).toBe('line2');
            });

            it('should return null at EOF', async () => {
                console.setInput('');
                expect(await console.readline()).toBeNull();
            });

            it('should return remaining text without newline', async () => {
                console.setInput('no newline');
                expect(await console.readline()).toBe('no newline');
                expect(await console.readline()).toBeNull();
            });
        });

        describe('isTTY', () => {
            it('should default to false', () => {
                expect(console.isTTY()).toBe(false);
            });

            it('should return set value', () => {
                console.setTTY(true);
                expect(console.isTTY()).toBe(true);

                console.setTTY(false);
                expect(console.isTTY()).toBe(false);
            });
        });

        describe('reset', () => {
            it('should clear all buffers', () => {
                console.setInput('input');
                console.write(new TextEncoder().encode('output'));
                console.error(new TextEncoder().encode('error'));

                console.reset();

                expect(console.getOutput()).toBe('');
                expect(console.getErrors()).toBe('');
            });
        });

        describe('setInput with Uint8Array', () => {
            it('should accept binary data', async () => {
                const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
                console.setInput(data);
                const result = await console.read();
                expect(new TextDecoder().decode(result)).toBe('Hello');
            });
        });
    });

    describe('BunConsoleDevice', () => {
        let consoleDevice: BunConsoleDevice;

        beforeEach(() => {
            consoleDevice = new BunConsoleDevice();
        });

        describe('isTTY', () => {
            it('should return boolean', () => {
                // May be true or false depending on environment
                expect(typeof consoleDevice.isTTY()).toBe('boolean');
            });
        });

        describe('write', () => {
            it('should not throw', () => {
                // Just verify it doesn't throw
                consoleDevice.write(new Uint8Array(0));
            });
        });

        describe('error', () => {
            it('should not throw', () => {
                consoleDevice.error(new Uint8Array(0));
            });
        });

        // Note: read() and readline() tests are harder to automate
        // as they depend on actual stdin which we can't easily mock
    });
});
