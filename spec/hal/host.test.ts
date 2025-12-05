import { describe, it, expect, beforeEach } from 'bun:test';
import { MockHostDevice, BunHostDevice } from '@src/hal/index.js';

describe('Host Device', () => {
    describe('MockHostDevice', () => {
        let host: MockHostDevice;

        beforeEach(() => {
            host = new MockHostDevice();
        });

        describe('exec', () => {
            it('should return command not found for unknown commands', async () => {
                const result = await host.exec('nonexistent');

                expect(result.exitCode).toBe(127);
                expect(result.stderr).toContain('command not found');
            });

            it('should return configured response', async () => {
                host.addCommand('test', {
                    exitCode: 0,
                    stdout: 'test output',
                    stderr: '',
                });

                const result = await host.exec('test');

                expect(result.exitCode).toBe(0);
                expect(result.stdout).toBe('test output');
            });

            it('should handle commands with stderr', async () => {
                host.addCommand('error', {
                    exitCode: 1,
                    stdout: '',
                    stderr: 'error message',
                });

                const result = await host.exec('error');

                expect(result.exitCode).toBe(1);
                expect(result.stderr).toBe('error message');
            });
        });

        describe('spawn', () => {
            it('should return process with pid', () => {
                host.addCommand('test', { exitCode: 0 });
                const proc = host.spawn('test');

                expect(typeof proc.pid).toBe('number');
            });

            it('should have stdout stream', async () => {
                host.addCommand('test', { exitCode: 0, stdout: 'output' });
                const proc = host.spawn('test');

                const reader = proc.stdout!.getReader();
                const { value } = await reader.read();

                expect(new TextDecoder().decode(value)).toBe('output');
            });

            it('should return exit code on wait', async () => {
                host.addCommand('test', { exitCode: 42 });
                const proc = host.spawn('test');
                const result = await proc.wait();

                expect(result.exitCode).toBe(42);
            });

            it('should track running state', async () => {
                host.addCommand('test', { exitCode: 0 });
                const proc = host.spawn('test');

                expect(proc.running).toBe(true);
                await proc.wait();
                expect(proc.running).toBe(false);
            });
        });

        describe('platform', () => {
            it('should return default platform', () => {
                expect(host.platform()).toBe('linux');
            });

            it('should return configured platform', () => {
                host.setPlatform('darwin');
                expect(host.platform()).toBe('darwin');
            });
        });

        describe('arch', () => {
            it('should return default arch', () => {
                expect(host.arch()).toBe('x64');
            });

            it('should return configured arch', () => {
                host.setArch('arm64');
                expect(host.arch()).toBe('arm64');
            });
        });

        describe('hostname', () => {
            it('should return default hostname', () => {
                expect(host.hostname()).toBe('mock-host');
            });

            it('should return configured hostname', () => {
                host.setHostname('test-server');
                expect(host.hostname()).toBe('test-server');
            });
        });

        describe('stat', () => {
            it('should return default stats', () => {
                const stat = host.stat();

                expect(stat.cpus).toBe(4);
                expect(stat.memtotal).toBe(8 * 1024 * 1024 * 1024);
                expect(stat.memfree).toBe(4 * 1024 * 1024 * 1024);
            });

            it('should return configured stats', () => {
                host.setStat({ cpus: 8, memtotal: 16e9, memfree: 8e9 });
                const stat = host.stat();

                expect(stat.cpus).toBe(8);
                expect(stat.memtotal).toBe(16e9);
                expect(stat.memfree).toBe(8e9);
            });
        });

        describe('getenv', () => {
            it('should return undefined for missing var', () => {
                expect(host.getenv('MISSING')).toBeUndefined();
            });

            it('should return configured var', () => {
                host.setEnv({ TEST_VAR: 'test value' });
                expect(host.getenv('TEST_VAR')).toBe('test value');
            });
        });

        describe('reset', () => {
            it('should clear all configuration', () => {
                host.addCommand('test', { exitCode: 0 });
                host.setPlatform('darwin');
                host.setArch('arm64');
                host.setHostname('test');
                host.setEnv({ VAR: 'value' });

                host.reset();

                expect(host.platform()).toBe('linux');
                expect(host.arch()).toBe('x64');
                expect(host.hostname()).toBe('mock-host');
                expect(host.getenv('VAR')).toBeUndefined();
            });
        });
    });

    describe('BunHostDevice', () => {
        let host: BunHostDevice;

        beforeEach(() => {
            host = new BunHostDevice();
        });

        describe('exec', () => {
            it('should execute real command', async () => {
                const result = await host.exec('echo', ['hello']);

                expect(result.exitCode).toBe(0);
                expect(result.stdout.trim()).toBe('hello');
            });

            it('should return non-zero for failing command', async () => {
                const result = await host.exec('false');

                expect(result.exitCode).not.toBe(0);
            });
        });

        describe('spawn', () => {
            it('should spawn process', () => {
                const proc = host.spawn('echo', ['test']);

                expect(typeof proc.pid).toBe('number');
                expect(proc.pid).toBeGreaterThan(0);
            });

            it('should capture stdout', async () => {
                const proc = host.spawn('echo', ['hello'], { stdout: 'pipe' });
                const reader = proc.stdout!.getReader();
                const { value } = await reader.read();

                expect(new TextDecoder().decode(value).trim()).toBe('hello');
                await proc.wait();
            });
        });

        describe('platform', () => {
            it('should return valid platform', () => {
                const platform = host.platform();

                expect(['darwin', 'linux', 'win32']).toContain(platform);
            });
        });

        describe('arch', () => {
            it('should return valid arch', () => {
                const arch = host.arch();

                expect(['x64', 'arm64', 'arm', 'ia32']).toContain(arch);
            });
        });

        describe('hostname', () => {
            it('should return non-empty hostname', () => {
                const hostname = host.hostname();

                expect(hostname.length).toBeGreaterThan(0);
            });
        });

        describe('stat', () => {
            it('should return valid stats', () => {
                const stat = host.stat();

                expect(stat.cpus).toBeGreaterThan(0);
                expect(stat.memtotal).toBeGreaterThan(0);
                expect(stat.memfree).toBeGreaterThanOrEqual(0);
                expect(stat.memfree).toBeLessThanOrEqual(stat.memtotal);
            });
        });

        describe('getenv', () => {
            it('should return PATH', () => {
                const path = host.getenv('PATH');

                expect(path).toBeDefined();
                expect(path!.length).toBeGreaterThan(0);
            });

            it('should return undefined for missing var', () => {
                expect(host.getenv('THIS_VAR_SHOULD_NOT_EXIST_12345')).toBeUndefined();
            });
        });
    });
});
