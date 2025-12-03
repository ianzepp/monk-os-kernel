#!/usr/bin/env bun
/**
 * Fixture Generator for Performance Tests
 *
 * Generates large test files for stress testing.
 * Run: bun run perf:fixtures
 */

import { mkdir } from 'node:fs/promises';
import { FIXTURE_DIR, writeFixture } from './bun-perf-setup.js';

const FIXTURES = {
    // Binary blobs
    'blob-1kb.bin': 1024,
    'blob-100kb.bin': 100 * 1024,
    'blob-1mb.bin': 1024 * 1024,
    'blob-10mb.bin': 10 * 1024 * 1024,

    // Text files (line counts, ~50 chars per line)
    'text-1k-lines.txt': 1_000,
    'text-10k-lines.txt': 10_000,
    'text-100k-lines.txt': 100_000,
    'text-1m-lines.txt': 1_000_000,
};

function generateBinaryBlob(size: number): Uint8Array {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        data[i] = i % 256;
    }
    return data;
}

function generateTextLines(lineCount: number): Uint8Array {
    const line = 'The quick brown fox jumps over the lazy dog.\n';
    const encoder = new TextEncoder();

    // Build in chunks to avoid memory issues with very large strings
    const chunkSize = 10_000;
    const chunks: Uint8Array[] = [];
    let remaining = lineCount;

    while (remaining > 0) {
        const count = Math.min(remaining, chunkSize);
        const text = line.repeat(count);
        chunks.push(encoder.encode(text));
        remaining -= count;
    }

    // Combine chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return result;
}

async function main() {
    console.log('Generating performance test fixtures...\n');

    // Ensure fixture directory exists
    await mkdir(FIXTURE_DIR, { recursive: true });

    for (const [name, size] of Object.entries(FIXTURES)) {
        const isBinary = name.endsWith('.bin');
        const isText = name.endsWith('.txt');

        let data: Uint8Array;
        let sizeLabel: string;

        if (isBinary) {
            data = generateBinaryBlob(size);
            sizeLabel = formatBytes(size);
        } else if (isText) {
            data = generateTextLines(size);
            sizeLabel = `${size.toLocaleString()} lines (${formatBytes(data.length)})`;
        } else {
            continue;
        }

        await writeFixture(name, data);
        console.log(`  ${name}: ${sizeLabel}`);
    }

    console.log('\nFixtures generated in .perf/');
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch(console.error);
