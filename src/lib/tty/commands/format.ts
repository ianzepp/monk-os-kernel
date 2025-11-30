/**
 * format - Convert JSON to various output formats
 *
 * Usage:
 *   format <type>
 *   cat data.json | format <type>
 *   select * FROM users | format csv
 *
 * Converts JSON input to the specified format using @monk/formatter-* packages.
 *
 * Available formats:
 *   csv        - Comma-separated values
 *   markdown   - Markdown table
 *   toml       - TOML format
 *   toon       - Token-Oriented Object Notation (compact for LLMs)
 *   grid       - Compact grid format
 *   cbor       - Concise Binary Object Representation (base64)
 *   msgpack    - MessagePack (base64)
 *   qr         - QR code (ASCII art)
 *   morse      - Morse code
 *   brainfuck  - Brainfuck (just for fun)
 *
 * Examples:
 *   select * FROM users | format csv
 *   cat data.json | format markdown
 *   select * FROM products | format toon
 */

import type { CommandHandler } from './shared.js';
import type { Formatter } from '@monk/common';
import { fromBytes } from '@monk/common';

// Formatter registry - lazy loaded
const formatters: Record<string, () => Promise<Formatter>> = {
    csv: async () => (await import('@monk/formatter-csv')).CsvFormatter,
    markdown: async () => (await import('@monk/formatter-markdown')).MarkdownFormatter,
    toml: async () => (await import('@monk/formatter-toml')).TomlFormatter,
    toon: async () => (await import('@monk/formatter-toon')).ToonFormatter,
    grid: async () => (await import('@monk/formatter-grid-compact')).GridCompactFormatter,
    cbor: async () => (await import('@monk/formatter-cbor')).CborFormatter,
    msgpack: async () => (await import('@monk/formatter-msgpack')).MsgpackFormatter,
    qr: async () => (await import('@monk/formatter-qr')).QrFormatter,
    morse: async () => (await import('@monk/formatter-morse')).MorseFormatter,
    brainfuck: async () => (await import('@monk/formatter-brainfuck')).BrainfuckFormatter,
};

// Aliases
const aliases: Record<string, string> = {
    md: 'markdown',
    table: 'markdown',
    compact: 'grid',
};

export const format: CommandHandler = async (session, fs, args, io) => {
    if (args.length === 0) {
        io.stderr.write('format: missing type\n');
        io.stderr.write('Usage: format <type>\n');
        io.stderr.write('Types: ' + Object.keys(formatters).join(', ') + '\n');
        return 1;
    }

    // Resolve type (handle aliases)
    let formatType = args[0].toLowerCase();
    if (aliases[formatType]) {
        formatType = aliases[formatType];
    }

    // Check if format is supported
    if (!formatters[formatType]) {
        io.stderr.write(`format: unknown type: ${args[0]}\n`);
        io.stderr.write('Available: ' + Object.keys(formatters).join(', ') + '\n');
        return 1;
    }

    // Read JSON from stdin
    const chunks: string[] = [];
    for await (const chunk of io.stdin) {
        chunks.push(chunk.toString());
    }
    const input = chunks.join('');

    if (!input.trim()) {
        io.stderr.write('format: no input provided\n');
        return 1;
    }

    // Parse JSON input
    let data: any;
    try {
        data = JSON.parse(input);
    } catch (err) {
        io.stderr.write('format: invalid JSON input\n');
        return 1;
    }

    // Load formatter and encode
    try {
        const formatter = await formatters[formatType]();
        const encoded = formatter.encode(data);

        // Check if output is binary (cbor, msgpack) - output as base64
        const isBinary = formatType === 'cbor' || formatType === 'msgpack';
        if (isBinary) {
            const base64 = Buffer.from(encoded).toString('base64');
            io.stdout.write(base64 + '\n');
        } else {
            const output = fromBytes(encoded);
            io.stdout.write(output);
            // Add newline if output doesn't end with one
            if (!output.endsWith('\n')) {
                io.stdout.write('\n');
            }
        }

        return 0;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.stderr.write(`format: ${msg}\n`);
        return 1;
    }
};
