/**
 * AI tool definitions and execution
 */

import type { Session, CommandIO } from '../../types.js';
import type { FS } from '@src/lib/fs/index.js';
import { executeLine } from '../../executor.js';
import { PassThrough } from 'node:stream';

// Tool definitions for AI capabilities
export const TOOLS = [
    {
        name: 'run_command',
        description: 'Execute a shell command in monksh and return the output. Use this to explore the filesystem, query data, run utilities, etc. Do NOT use this for reading or writing files - use read_file and write_file instead.',
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The shell command to execute (e.g., "ls -la", "select * from users", "ps")',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'read_file',
        description: 'Read the contents of a file. Use this instead of cat or run_command for reading files.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to read (absolute or relative to current directory)',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Use this instead of echo/redirect for writing files.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'The file path to write (absolute or relative to current directory)',
                },
                content: {
                    type: 'string',
                    description: 'The content to write to the file',
                },
            },
            required: ['path', 'content'],
        },
    },
];

/**
 * Execute a command and capture its output
 */
export async function executeCommandCapture(
    session: Session,
    _fs: FS | null,
    command: string,
    parentIO: CommandIO
): Promise<string> {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdin.end();

    const io: CommandIO = { stdin, stdout, stderr };

    let output = '';

    stdout.on('data', (chunk) => {
        output += chunk.toString();
        // Don't echo stdout - AI will summarize
    });

    stderr.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        parentIO.stderr.write(`\x1b[31m${text}\x1b[0m`); // Show errors to user
    });

    try {
        const exitCode = await executeLine(session, command, io, {
            addToHistory: false,
            useTransaction: true,
        });

        if (exitCode !== 0) {
            output += `\n[Exit code: ${exitCode}]`;
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `\n[Error: ${message}]`;
    }

    return output || '[No output]';
}
