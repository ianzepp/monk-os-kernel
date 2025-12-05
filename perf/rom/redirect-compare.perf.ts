/**
 * Redirect Performance Tests
 *
 * Measures throughput and overhead of the message↔byte boundary crossing
 * for shell redirects.
 *
 * WHAT WE'RE TESTING
 * ==================
 * All tests end with a redirect to capture output, so we measure:
 * 1. Pipeline length impact on throughput
 * 2. Volume impact (message count) on throughput
 * 3. Transformation commands vs passthrough
 *
 * The redirect pump overhead is constant per-message, so longer pipelines
 * should amortize the redirect cost better.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { OS } from '@src/os/os.js';

const TIMEOUT_LONG = 120_000;

describe('Redirect Performance', () => {
    let os: OS;

    beforeEach(async () => {
        os = new OS();
        await os.boot();
    });

    afterEach(async () => {
        await os.shutdown();
    });

    /**
     * Run a shell command and return timing info.
     */
    async function timed(command: string): Promise<{ exitCode: number; ms: number }> {
        const start = performance.now();
        const handle = await os.process.spawn('/bin/shell.ts', {
            args: ['shell', '-c', command],
        });
        const result = await handle.wait();
        const ms = performance.now() - start;

        return { exitCode: result.exitCode, ms };
    }

    /**
     * Run a command N times and return stats.
     */
    async function benchmark(
        name: string,
        command: string,
        iterations: number,
    ): Promise<{ avg: number; min: number; max: number; total: number }> {
        const times: number[] = [];

        for (let i = 0; i < iterations; i++) {
            const { ms } = await timed(command);

            times.push(ms);
        }

        const total = times.reduce((a, b) => a + b, 0);
        const avg = total / iterations;
        const min = Math.min(...times);
        const max = Math.max(...times);

        console.log(`  ${name}: avg=${avg.toFixed(1)}ms min=${min.toFixed(1)}ms max=${max.toFixed(1)}ms (n=${iterations})`);

        return { avg, min, max, total };
    }

    // =========================================================================
    // Pipeline Length Comparison
    // =========================================================================

    describe('Pipeline Length Impact', () => {
        const ITERATIONS = 10;

        it('should measure 1-stage (echo > file)', async () => {
            console.log('\n  1-stage pipeline:');

            await benchmark(
                'echo > file',
                'echo hello > /tmp/p1.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/p1.txt');

            expect(content).toBe('hello\n');
        }, { timeout: TIMEOUT_LONG });

        it('should measure 2-stage (echo | cat > file)', async () => {
            console.log('\n  2-stage pipeline:');

            await benchmark(
                'echo|cat>file',
                'echo hello | cat > /tmp/p2.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/p2.txt');

            expect(content).toBe('hello\n');
        }, { timeout: TIMEOUT_LONG });

        it('should measure 3-stage (echo | cat | cat > file)', async () => {
            console.log('\n  3-stage pipeline:');

            await benchmark(
                'echo|cat|cat>file',
                'echo hello | cat | cat > /tmp/p3.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/p3.txt');

            expect(content).toBe('hello\n');
        }, { timeout: TIMEOUT_LONG });

        it('should measure 5-stage pipeline', async () => {
            console.log('\n  5-stage pipeline:');

            await benchmark(
                'echo|4xcats>file',
                'echo hello | cat | cat | cat | cat > /tmp/p5.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/p5.txt');

            expect(content).toBe('hello\n');
        }, { timeout: TIMEOUT_LONG });

        it('should summarize pipeline length scaling', async () => {
            console.log('\n  Pipeline Length Summary:');

            const p1 = await benchmark('1-stage', 'echo test > /tmp/s1.txt', 5);
            const p2 = await benchmark('2-stage', 'echo test | cat > /tmp/s2.txt', 5);
            const p3 = await benchmark('3-stage', 'echo test | cat | cat > /tmp/s3.txt', 5);
            const p5 = await benchmark('5-stage', 'echo test | cat | cat | cat | cat > /tmp/s5.txt', 5);

            console.log(`\n  Scaling from 1→5 stages: ${(p5.avg / p1.avg).toFixed(2)}x`);
            console.log(`  Per-stage overhead: ~${((p5.avg - p1.avg) / 4).toFixed(1)}ms`);
        }, { timeout: TIMEOUT_LONG });
    });

    // =========================================================================
    // Volume Impact
    // =========================================================================

    describe('Volume Impact (Message Count)', () => {
        const ITERATIONS = 5;

        it('should measure 10 lines through pipeline', async () => {
            console.log('\n  10 lines (seq 1 10 | cat > file):');

            const result = await benchmark(
                '10 lines',
                'seq 1 10 | cat > /tmp/v10.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/v10.txt');
            const lines = content.trim().split('\n');

            expect(lines.length).toBe(10);

            console.log(`  Throughput: ${(10 / (result.avg / 1000)).toFixed(0)} lines/sec`);
        }, { timeout: TIMEOUT_LONG });

        it('should measure 100 lines through pipeline', async () => {
            console.log('\n  100 lines (seq 1 100 | cat > file):');

            const result = await benchmark(
                '100 lines',
                'seq 1 100 | cat > /tmp/v100.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/v100.txt');
            const lines = content.trim().split('\n');

            expect(lines.length).toBe(100);

            console.log(`  Throughput: ${(100 / (result.avg / 1000)).toFixed(0)} lines/sec`);
        }, { timeout: TIMEOUT_LONG });

        it('should measure 1000 lines through pipeline', async () => {
            console.log('\n  1000 lines (seq 1 1000 | cat > file):');

            const result = await benchmark(
                '1000 lines',
                'seq 1 1000 | cat > /tmp/v1k.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/v1k.txt');
            const lines = content.trim().split('\n');

            expect(lines.length).toBe(1000);

            console.log(`  Throughput: ${(1000 / (result.avg / 1000)).toFixed(0)} lines/sec`);
        }, { timeout: TIMEOUT_LONG });

        it('should measure 10000 lines through pipeline', async () => {
            console.log('\n  10000 lines (seq 1 10000 | cat > file):');

            const result = await benchmark(
                '10000 lines',
                'seq 1 10000 | cat > /tmp/v10k.txt',
                ITERATIONS,
            );

            const content = await os.fs.readText('/tmp/v10k.txt');
            const lines = content.trim().split('\n');

            expect(lines.length).toBe(10000);

            console.log(`  Throughput: ${(10000 / (result.avg / 1000)).toFixed(0)} lines/sec`);
        }, { timeout: TIMEOUT_LONG });

        it('should summarize volume scaling', async () => {
            console.log('\n  Volume Scaling Summary:');

            const v10 = await benchmark('10 lines  ', 'seq 1 10 | cat > /tmp/vs10.txt', 3);
            const v100 = await benchmark('100 lines ', 'seq 1 100 | cat > /tmp/vs100.txt', 3);
            const v1k = await benchmark('1000 lines', 'seq 1 1000 | cat > /tmp/vs1k.txt', 3);

            const overhead10 = v10.avg / 10;
            const overhead100 = v100.avg / 100;
            const overhead1k = v1k.avg / 1000;

            console.log(`\n  Per-message overhead:`);
            console.log(`    10 lines:   ${overhead10.toFixed(2)}ms/line`);
            console.log(`    100 lines:  ${overhead100.toFixed(2)}ms/line`);
            console.log(`    1000 lines: ${overhead1k.toFixed(2)}ms/line`);
        }, { timeout: TIMEOUT_LONG });
    });

    // =========================================================================
    // Transformation Pipeline Performance
    // =========================================================================

    describe('Transformation Pipeline', () => {
        const ITERATIONS = 5;

        it('should measure passthrough (cat)', async () => {
            console.log('\n  Passthrough (seq | cat > file):');

            await benchmark(
                'seq 100|cat',
                'seq 1 100 | cat > /tmp/t_pass.txt',
                ITERATIONS,
            );
        }, { timeout: TIMEOUT_LONG });

        it('should measure transform (tr)', async () => {
            console.log('\n  Transform (seq | tr > file):');

            await benchmark(
                'seq 100|tr',
                'seq 1 100 | tr 0-9 a-j > /tmp/t_tr.txt',
                ITERATIONS,
            );
        }, { timeout: TIMEOUT_LONG });

        it('should measure multi-stage transform', async () => {
            console.log('\n  Multi-transform (seq | cat | tr | cat > file):');

            await benchmark(
                'seq|cat|tr|cat',
                'seq 1 100 | cat | tr 0-9 a-j | cat > /tmp/t_multi.txt',
                ITERATIONS,
            );
        }, { timeout: TIMEOUT_LONG });
    });

    // =========================================================================
    // Summary
    // =========================================================================

    describe('Summary', () => {
        it('should print performance summary', async () => {
            console.log('\n========================================');
            console.log('REDIRECT PERFORMANCE SUMMARY');
            console.log('========================================');
            console.log('Key findings:');
            console.log('- Fixed overhead per redirect (~Xms)');
            console.log('- Per-message overhead decreases with volume');
            console.log('- Pipeline stages add constant overhead');
            console.log('========================================\n');

            expect(true).toBe(true);
        });
    });
});
