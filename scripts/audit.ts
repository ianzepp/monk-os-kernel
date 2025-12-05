#!/usr/bin/env bun

/**
 * Audit Script - Comprehensive codebase health check
 *
 * Runs typecheck, lint, tests, and build in optimized order.
 * Outputs filtered results to tmp/audit-{timestamp}.md
 *
 * Phase 1 (parallel): typecheck (all 3), lint, test, perf
 * Phase 2 (sequential, only if Phase 1 passes): build, build:warn
 *
 * @module scripts/audit
 */

import { $ } from 'bun';

// =============================================================================
// Types
// =============================================================================

interface CommandResult {
    name: string;
    passed: boolean;
    duration: number;
    output: string;
    filtered: string;
}

// =============================================================================
// Configuration
// =============================================================================

const PHASE1_COMMANDS: Array<{ name: string; cmd: string[]; filter: (out: string) => string }> = [
    {
        name: 'typecheck',
        cmd: ['bun', 'x', 'tsc', '--noEmit'],
        filter: filterTypecheck,
    },
    {
        name: 'typecheck:spec',
        cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', 'tsconfig.spec.json'],
        filter: filterTypecheck,
    },
    {
        name: 'typecheck:perf',
        cmd: ['bun', 'x', 'tsc', '--noEmit', '-p', 'tsconfig.perf.json'],
        filter: filterTypecheck,
    },
    {
        name: 'lint',
        cmd: ['bun', 'run', 'lint'],
        filter: filterLint,
    },
    {
        name: 'test',
        cmd: ['bun', 'run', 'test'],
        filter: filterTests,
    },
    {
        name: 'perf',
        cmd: ['bun', 'run', 'perf'],
        filter: filterPerf,
    },
];

const PHASE2_COMMANDS: Array<{ name: string; cmd: string[]; filter: (out: string) => string }> = [
    {
        name: 'build',
        cmd: ['scripts/build.sh'],
        filter: filterBuild,
    },
    {
        name: 'build:warn',
        cmd: ['scripts/build-warn.sh'],
        filter: filterBuildWarn,
    },
];

// =============================================================================
// Filters
// =============================================================================

function filterTypecheck(output: string): string {
    const lines = output.split('\n');
    const errors: string[] = [];

    for (const line of lines) {
        // Keep lines with TypeScript errors (file:line:col - error TS...)
        if (line.includes(': error TS')) {
            errors.push(line);
        }
    }

    if (errors.length === 0) {
        return 'No errors';
    }

    return errors.join('\n');
}

function filterLint(output: string): string {
    const lines = output.split('\n');

    // Count errors per file for summary
    const fileCounts = new Map<string, { errors: number; warnings: number }>();
    let currentFile = '';
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const line of lines) {
        // File path line (starts with /)
        if (line.match(/^\/.*\.(ts|js)$/)) {
            currentFile = line.replace(process.cwd() + '/', '');
            continue;
        }

        // Error/warning line
        if (currentFile && line.match(/^\s+\d+:\d+\s+(error|warning)/)) {
            const isError = line.includes(' error ');
            const counts = fileCounts.get(currentFile) || { errors: 0, warnings: 0 };

            if (isError) {
                counts.errors++;
                totalErrors++;
            }
            else {
                counts.warnings++;
                totalWarnings++;
            }

            fileCounts.set(currentFile, counts);
        }
    }

    if (fileCounts.size === 0) {
        return 'No issues';
    }

    // Build summary output
    const result: string[] = [];
    result.push(`${totalErrors} errors, ${totalWarnings} warnings across ${fileCounts.size} files`);
    result.push('');

    // Show top 10 files by error count
    const sorted = [...fileCounts.entries()]
        .sort((a, b) => b[1].errors - a[1].errors)
        .slice(0, 10);

    for (const [file, counts] of sorted) {
        result.push(`  ${file}: ${counts.errors} errors, ${counts.warnings} warnings`);
    }

    if (fileCounts.size > 10) {
        result.push(`  ... and ${fileCounts.size - 10} more files`);
    }

    return result.join('\n');
}

function filterTests(output: string): string {
    const lines = output.split('\n');
    const relevant: string[] = [];

    for (const line of lines) {
        // Keep failure lines (important)
        if (line.includes('✗') || line.includes('(fail)')) {
            relevant.push(line);
            continue;
        }

        // Keep summary lines
        if (line.match(/^\d+ pass/) || line.match(/^\d+ fail/) || line.match(/^\d+ skip/)) {
            relevant.push(line);
            continue;
        }

        // Keep timing line
        if (line.match(/Ran \d+ tests/)) {
            relevant.push(line);
        }
    }

    if (relevant.length === 0) {
        return 'No test output captured';
    }

    return relevant.join('\n');
}

function filterPerf(output: string): string {
    const lines = output.split('\n');
    const relevant: string[] = [];
    const failures: string[] = [];

    for (const line of lines) {
        // Capture failure lines
        if (line.includes('(fail)')) {
            failures.push(line.trim());
            continue;
        }

        // Keep summary lines
        if (line.match(/^\s*\d+ pass/) || line.match(/^\s*\d+ fail/) || line.match(/^\s*\d+ skip/)) {
            relevant.push(line.trim());
            continue;
        }

        // Keep timing line
        if (line.match(/Ran \d+ tests/)) {
            relevant.push(line.trim());
        }
    }

    // Build output: summary first, then failures
    const result: string[] = [];

    if (relevant.length > 0) {
        result.push(...relevant);
    }

    if (failures.length > 0) {
        result.push('');
        result.push('Failures:');

        // Show up to 10 failures
        for (const f of failures.slice(0, 10)) {
            result.push(`  ${f}`);
        }

        if (failures.length > 10) {
            result.push(`  ... and ${failures.length - 10} more failures`);
        }
    }

    if (result.length === 0) {
        return 'No perf output captured';
    }

    return result.join('\n');
}

function filterBuild(output: string): string {
    const lines = output.split('\n');
    const relevant: string[] = [];

    for (const line of lines) {
        // Keep INFO and ERROR lines
        if (line.includes('[INFO]') || line.includes('[ERROR]')) {
            // Strip ANSI codes for cleaner output
            relevant.push(stripAnsi(line));
        }
    }

    if (relevant.length === 0) {
        return 'No build output captured';
    }

    return relevant.join('\n');
}

function filterBuildWarn(output: string): string {
    const lines = output.split('\n');
    const relevant: string[] = [];

    for (const line of lines) {
        // Keep WARN, CHECK, and summary lines
        if (
            line.includes('[WARN]') ||
            line.includes('[CHECK]') ||
            line.includes('Total warnings') ||
            line.includes('No warnings found')
        ) {
            relevant.push(stripAnsi(line));
        }

        // Keep violation lines (→)
        if (line.includes('→')) {
            relevant.push(stripAnsi(line));
        }
    }

    if (relevant.length === 0) {
        return 'No warnings output captured';
    }

    return relevant.join('\n');
}

function stripAnsi(str: string): string {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

// =============================================================================
// Command Execution
// =============================================================================

async function runCommand(
    name: string,
    cmd: string[],
    filter: (out: string) => string
): Promise<CommandResult> {
    const start = Date.now();
    let output = '';
    let passed = false;

    try {
        const proc = Bun.spawn(cmd, {
            stdout: 'pipe',
            stderr: 'pipe',
            cwd: process.cwd(),
        });

        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);

        const exitCode = await proc.exited;
        output = stdout + '\n' + stderr;
        passed = exitCode === 0;
    }
    catch (err) {
        output = `Command failed: ${err}`;
        passed = false;
    }

    const duration = Date.now() - start;
    const filtered = filter(output);

    return { name, passed, duration, output, filtered };
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(
    phase1Results: CommandResult[],
    phase2Results: CommandResult[],
    phase1Passed: boolean
): string {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

    const lines: string[] = [];

    lines.push(`# Audit Report - ${timestamp}`);
    lines.push('');

    // -------------------------------------------------------------------------
    // Summary
    // -------------------------------------------------------------------------

    lines.push('## Summary');
    lines.push('');
    lines.push('| Check | Status | Time |');
    lines.push('|-------|--------|------|');

    for (const r of phase1Results) {
        const status = r.passed ? '✓ PASS' : '✗ FAIL';
        const time = `${(r.duration / 1000).toFixed(1)}s`;
        lines.push(`| ${r.name} | ${status} | ${time} |`);
    }

    if (phase1Passed) {
        for (const r of phase2Results) {
            const status = r.passed ? '✓ PASS' : '✗ FAIL';
            const time = `${(r.duration / 1000).toFixed(1)}s`;
            lines.push(`| ${r.name} | ${status} | ${time} |`);
        }
    }
    else {
        lines.push('| build | ⏭ SKIPPED | - |');
        lines.push('| build:warn | ⏭ SKIPPED | - |');
    }

    lines.push('');

    // -------------------------------------------------------------------------
    // Phase 1 Details
    // -------------------------------------------------------------------------

    const phase1Failures = phase1Results.filter(r => !r.passed);
    const phase1Warnings = phase1Results.filter(
        r => r.passed && r.filtered !== 'No errors' && r.filtered !== 'No issues'
    );

    if (phase1Failures.length > 0) {
        lines.push('## Phase 1 Failures');
        lines.push('');

        for (const r of phase1Failures) {
            lines.push(`### ${r.name}`);
            lines.push('');
            lines.push('```');
            lines.push(r.filtered);
            lines.push('```');
            lines.push('');
        }
    }

    // -------------------------------------------------------------------------
    // Phase 2 Details (build warnings are always shown if run)
    // -------------------------------------------------------------------------

    if (phase1Passed && phase2Results.length > 0) {
        const buildWarn = phase2Results.find(r => r.name === 'build:warn');

        if (buildWarn && buildWarn.filtered !== 'No warnings output captured') {
            lines.push('## Build Warnings');
            lines.push('');
            lines.push('```');
            lines.push(buildWarn.filtered);
            lines.push('```');
            lines.push('');
        }

        const buildFailures = phase2Results.filter(r => !r.passed);

        if (buildFailures.length > 0) {
            lines.push('## Phase 2 Failures');
            lines.push('');

            for (const r of buildFailures) {
                lines.push(`### ${r.name}`);
                lines.push('');
                lines.push('```');
                lines.push(r.filtered);
                lines.push('```');
                lines.push('');
            }
        }
    }

    // -------------------------------------------------------------------------
    // Test Details (always show test output for context)
    // -------------------------------------------------------------------------

    const testResult = phase1Results.find(r => r.name === 'test');
    const perfResult = phase1Results.find(r => r.name === 'perf');

    if (testResult || perfResult) {
        lines.push('## Test Output');
        lines.push('');

        if (testResult) {
            lines.push('### spec tests');
            lines.push('');
            lines.push('```');
            lines.push(testResult.filtered);
            lines.push('```');
            lines.push('');
        }

        if (perfResult) {
            lines.push('### perf tests');
            lines.push('');
            lines.push('```');
            lines.push(perfResult.filtered);
            lines.push('```');
            lines.push('');
        }
    }

    return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

async function main() {
    const startTime = Date.now();

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Monk OS Audit');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // -------------------------------------------------------------------------
    // Phase 1: Run all checks in parallel
    // -------------------------------------------------------------------------

    console.log('[PHASE 1] Running typecheck, lint, test, perf in parallel...');

    const phase1Promises = PHASE1_COMMANDS.map(c => runCommand(c.name, c.cmd, c.filter));
    const phase1Results = await Promise.all(phase1Promises);

    for (const r of phase1Results) {
        const status = r.passed ? '✓' : '✗';
        const time = `${(r.duration / 1000).toFixed(1)}s`;
        console.log(`  ${status} ${r.name} (${time})`);
    }

    const phase1Passed = phase1Results.every(r => r.passed);

    console.log('');

    // -------------------------------------------------------------------------
    // Phase 2: Build (only if Phase 1 passed)
    // -------------------------------------------------------------------------

    let phase2Results: CommandResult[] = [];

    if (phase1Passed) {
        console.log('[PHASE 2] Running build...');

        for (const c of PHASE2_COMMANDS) {
            const result = await runCommand(c.name, c.cmd, c.filter);
            phase2Results.push(result);

            const status = result.passed ? '✓' : '✗';
            const time = `${(result.duration / 1000).toFixed(1)}s`;
            console.log(`  ${status} ${result.name} (${time})`);

            // Stop if build fails
            if (!result.passed) {
                break;
            }
        }
    }
    else {
        console.log('[PHASE 2] Skipped (Phase 1 had failures)');
    }

    console.log('');

    // -------------------------------------------------------------------------
    // Generate Report
    // -------------------------------------------------------------------------

    const report = generateReport(phase1Results, phase2Results, phase1Passed);

    // Ensure tmp/ exists
    await $`mkdir -p tmp`.quiet();

    // Write report
    const now = new Date();
    const ts = now.toISOString().replace(/[-:T]/g, '').substring(0, 14);
    const filename = `tmp/audit-${ts}.md`;

    await Bun.write(filename, report);

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    const allPassed = phase1Passed && phase2Results.every(r => r.passed);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (allPassed) {
        console.log(`  ✓ All checks passed (${totalTime}s)`);
    }
    else {
        console.log(`  ✗ Some checks failed (${totalTime}s)`);
    }

    console.log(`  Report: ${filename}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Echo the filename for easy consumption
    console.log(filename);
}

main().catch(err => {
    console.error('Audit failed:', err);
    process.exit(1);
});
