/**
 * read - Read a line from stdin into variable(s)
 *
 * Usage:
 *   read VAR              Read line into VAR
 *   read VAR1 VAR2 ...    Split line into multiple variables
 *   read -p PROMPT VAR    Display prompt before reading
 *   read -r VAR           Raw mode (don't interpret backslashes)
 *
 * When reading from a pipe, reads one line from stdin.
 * The last variable gets the remainder of the line.
 *
 * Examples:
 *   echo "hello" | read greeting
 *   echo "a b c d" | read first second rest  # rest="c d"
 *   cat file.txt | while read line; do echo $line; done
 */

import type { CommandHandler } from './shared.js';

export const read: CommandHandler = async (session, _fs, args, io) => {
    // Parse options
    let prompt = '';
    let raw = false;
    const varNames: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-p' && args[i + 1]) {
            prompt = args[++i];
        } else if (arg === '-r') {
            raw = true;
        } else if (!arg.startsWith('-')) {
            varNames.push(arg);
        }
    }

    if (varNames.length === 0) {
        io.stderr.write('read: missing variable name\n');
        return 1;
    }

    // Validate variable names
    for (const name of varNames) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
            io.stderr.write(`read: invalid variable name: ${name}\n`);
            return 1;
        }
    }

    // Show prompt if provided
    if (prompt) {
        io.stdout.write(prompt);
    }

    // Read one line from stdin
    const line = await readLine(io.stdin);

    // EOF with no data
    if (line === null) {
        // Set all variables to empty
        for (const name of varNames) {
            session.env[name] = '';
        }
        return 1;
    }

    // Process backslashes unless raw mode
    let processed = line;
    if (!raw) {
        processed = processed
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\');
    }

    // Split line into words and assign to variables
    const words = processed.split(/\s+/).filter(w => w.length > 0);

    for (let i = 0; i < varNames.length; i++) {
        if (i === varNames.length - 1) {
            // Last variable gets the rest
            session.env[varNames[i]] = words.slice(i).join(' ');
        } else {
            session.env[varNames[i]] = words[i] || '';
        }
    }

    return 0;
};

/**
 * Read a single line from the stream
 */
async function readLine(stdin: NodeJS.ReadableStream): Promise<string | null> {
    return new Promise((resolve) => {
        let buffer = '';
        let resolved = false;

        const onData = (chunk: Buffer | string) => {
            if (resolved) return;

            buffer += chunk.toString();
            const newlineIndex = buffer.indexOf('\n');

            if (newlineIndex !== -1) {
                resolved = true;
                stdin.removeListener('data', onData);
                stdin.removeListener('end', onEnd);
                // Return line without newline
                resolve(buffer.slice(0, newlineIndex));
            }
        };

        const onEnd = () => {
            if (resolved) return;
            resolved = true;
            stdin.removeListener('data', onData);
            // Return whatever we have, or null if empty
            resolve(buffer.length > 0 ? buffer : null);
        };

        stdin.on('data', onData);
        stdin.on('end', onEnd);
    });
}
