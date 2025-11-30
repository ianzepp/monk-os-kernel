/**
 * TTY Shell Mode
 *
 * Handles shell submode when AI is the primary interface.
 * Users enter shell mode via '!' or '! cmd' from AI mode.
 */

import type { Session, TTYStream } from './types.js';
import { TTY_CHARS } from './types.js';
import { executeLine, createIO } from './executor.js';
import { printPrompt } from './auth.js';

/**
 * Write to TTY stream with CRLF
 */
function writeToStream(stream: TTYStream, text: string): void {
    const normalized = text.replace(/(?<!\r)\n/g, '\r\n');
    stream.write(normalized);
}

/**
 * Enter shell mode from AI mode
 *
 * @param stream TTY stream
 * @param session Current session
 * @param singleCommand Optional command to run (for '! cmd' syntax)
 */
export async function enterShellMode(
    stream: TTYStream,
    session: Session,
    singleCommand?: string
): Promise<void> {
    session.mode = 'shell';
    session.shellTranscript = [];

    if (singleCommand) {
        // Execute single command and return to AI
        const output = await executeAndCapture(session, stream, singleCommand);
        session.shellTranscript.push(`$ ${singleCommand}\n${output}`);
        await exitShellMode(stream, session, true); // auto-share transcript
    } else {
        // Interactive shell mode
        writeToStream(stream, 'Entering shell mode. Type "exit" to return to AI.\n\n');
        printPrompt(stream, session);
    }
}

/**
 * Exit shell mode and return to AI mode
 *
 * @param stream TTY stream
 * @param session Current session
 * @param autoShare If true, automatically share transcript with AI
 */
export async function exitShellMode(
    stream: TTYStream,
    session: Session,
    autoShare = false
): Promise<void> {
    session.mode = 'ai';

    if (session.shellTranscript.length > 0 && !autoShare) {
        // Prompt user to share transcript (handled by caller for interactive confirmation)
        writeToStream(stream, '\nShell transcript available for AI context.\n');
    }

    writeToStream(stream, TTY_CHARS.AI_PROMPT);
}

/**
 * Execute a shell command and capture output
 */
async function executeAndCapture(
    session: Session,
    stream: TTYStream,
    command: string
): Promise<string> {
    const abortController = new AbortController();
    const io = createIO(abortController.signal);

    let output = '';

    io.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        writeToStream(stream, text);
    });

    io.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        writeToStream(stream, text);
    });

    io.stdin.end();

    try {
        await executeLine(session, command, io, {
            addToHistory: true,
            signal: abortController.signal,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output += `Error: ${message}\n`;
        writeToStream(stream, `Error: ${message}\n`);
    }

    return output;
}

/**
 * Process shell input while in shell mode
 *
 * @returns true if should continue in shell mode, false to exit
 */
export async function processShellInput(
    stream: TTYStream,
    session: Session,
    line: string
): Promise<boolean> {
    const trimmed = line.trim();

    // Exit command returns to AI mode
    if (trimmed === 'exit' || trimmed === 'quit') {
        await exitShellMode(stream, session);
        return false;
    }

    // Empty line - just show prompt
    if (!trimmed) {
        printPrompt(stream, session);
        return true;
    }

    // Execute command (@ commands work here via the shell's command system)
    const output = await executeAndCapture(session, stream, trimmed);
    session.shellTranscript.push(`$ ${trimmed}\n${output}`);

    // Check if exit command requested connection close
    if (session.shouldClose) {
        return false;
    }

    printPrompt(stream, session);
    return true;
}
