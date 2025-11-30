/**
 * TTY Session Handler
 *
 * Handles TTY input processing:
 * - Character-by-character input handling
 * - Escape sequence parsing (arrow keys)
 * - History navigation
 * - Tab completion for paths
 * - Line buffering and dispatch
 *
 * Delegates to:
 * - auth.ts for login/register states
 * - executor.ts for command execution
 */

import type { Session, TTYStream, TTYConfig } from './types.js';
import type { FS, FSEntry } from '@src/lib/fs/index.js';
import { handleAuthState, printPrompt } from './auth.js';
import { executeLine, createIO } from './executor.js';
import { saveHistory, applySessionMounts } from './profile.js';
import { FSError } from '@src/lib/fs/index.js';
import { runTransaction } from '@src/lib/transaction.js';
import { processAIInput, saveAIContext, cleanupAIState, abortAIRequest } from './ai-mode.js';
import { processShellInput } from './shell-mode.js';

/**
 * Write text to stream with CRLF line endings (telnet convention)
 */
export function writeToStream(stream: TTYStream, text: string): void {
    const normalized = text.replace(/(?<!\r)\n/g, '\r\n');
    stream.write(normalized);
}

import { TTY_CHARS } from './types.js';

/**
 * Handle CTRL+C (interrupt signal)
 *
 * @returns true if handled (don't disconnect), false if should disconnect
 */
export function handleInterrupt(stream: TTYStream, session: Session): boolean {
    // If a foreground command is running, abort it
    if (session.foregroundAbort) {
        session.foregroundAbort.abort();
        writeToStream(stream, '^C\n');
        return true;
    }

    // If in AI mode, try to abort any in-progress AI request
    if (session.authenticated && session.mode === 'ai') {
        if (abortAIRequest(session.id)) {
            // Abort was triggered - the AI handler will show ^C and prompt
            return true;
        }
    }

    // No command running - clear input and show new prompt
    if (session.authenticated) {
        writeToStream(stream, '^C\n');
        session.inputBuffer = '';
        session.historyIndex = -1;
        session.historyBuffer = '';

        // Show appropriate prompt based on mode
        if (session.mode === 'ai') {
            writeToStream(stream, TTY_CHARS.AI_PROMPT);
        } else {
            printPrompt(stream, session);
        }
        return true;
    }

    // Not authenticated - disconnect
    return false;
}

/**
 * Send login prompt
 */
export function sendWelcome(stream: TTYStream, _config?: TTYConfig): void {
    writeToStream(stream, '\nmonk login: ');
}

/**
 * Clear current line and write new content
 */
function replaceLine(stream: TTYStream, session: Session, newContent: string): void {
    const clearLen = session.inputBuffer.length;
    if (clearLen > 0) {
        writeToStream(stream, '\x1b[' + clearLen + 'D'); // Move left
        writeToStream(stream, '\x1b[K'); // Clear to end of line
    }
    session.inputBuffer = newContent;
    writeToStream(stream, newContent);
}

/**
 * Handle up arrow - navigate to previous command in history
 */
function handleHistoryUp(stream: TTYStream, session: Session): void {
    if (session.history.length === 0) return;

    if (session.historyIndex === -1) {
        session.historyBuffer = session.inputBuffer;
        session.historyIndex = session.history.length;
    }

    if (session.historyIndex > 0) {
        session.historyIndex--;
        replaceLine(stream, session, session.history[session.historyIndex]);
    }
}

/**
 * Handle down arrow - navigate to next command in history
 */
function handleHistoryDown(stream: TTYStream, session: Session): void {
    if (session.historyIndex === -1) return;

    session.historyIndex++;

    if (session.historyIndex >= session.history.length) {
        session.historyIndex = -1;
        replaceLine(stream, session, session.historyBuffer);
        session.historyBuffer = '';
    } else {
        replaceLine(stream, session, session.history[session.historyIndex]);
    }
}

/**
 * Handle tab completion for paths
 *
 * Completes the current word (space-delimited) as a filesystem path.
 * - Single match: completes the path, adds / for directories
 * - Multiple matches: shows all options on a new line
 * - No matches: does nothing (bell could be added)
 */
async function handleTabCompletion(stream: TTYStream, session: Session): Promise<void> {
    if (!session.systemInit) return;

    const input = session.inputBuffer;

    // Find the word being completed (last space-delimited token)
    const lastSpaceIndex = input.lastIndexOf(' ');
    const partial = input.slice(lastSpaceIndex + 1);

    // Run completion inside a transaction to access the filesystem
    await runTransaction(session.systemInit, async (system) => {
        applySessionMounts(session, system.fs, system);
        const fs = system.fs;

        // Determine directory to search and prefix to match
        let searchDir: string;
        let matchPrefix: string;

        if (partial === '') {
            // Empty partial - complete from cwd
            searchDir = session.cwd;
            matchPrefix = '';
        } else if (partial.endsWith('/')) {
            // Trailing slash - list contents of that directory
            searchDir = fs.resolve(session.cwd, partial);
            matchPrefix = '';
        } else {
            // Partial name - search parent directory
            const resolved = fs.resolve(session.cwd, partial);
            searchDir = fs.dirname(resolved);
            matchPrefix = fs.basename(resolved);
        }

        // Get directory contents
        let entries: FSEntry[];
        try {
            entries = await fs.readdir(searchDir);
        } catch (err) {
            if (err instanceof FSError && err.code === 'ENOENT') {
                return; // Directory doesn't exist
            }
            throw err;
        }

        // Filter to matching entries (exclude hidden files unless prefix starts with .)
        const showHidden = matchPrefix.startsWith('.');
        const matches = entries
            .filter((e: FSEntry) => e.name.startsWith(matchPrefix) && (showHidden || !e.name.startsWith('.')))
            .sort((a: FSEntry, b: FSEntry) => a.name.localeCompare(b.name));

        if (matches.length === 0) {
            return; // No matches
        }

        if (matches.length === 1) {
            // Single match - complete it
            const match = matches[0];
            const completion = match.name.slice(matchPrefix.length);
            const suffix = match.type === 'directory' ? '/' : ' ';

            session.inputBuffer = input + completion + suffix;
            writeToStream(stream, completion + suffix);
        } else {
            // Multiple matches - find common prefix and show options
            const names = matches.map((m: FSEntry) => m.name);
            const commonPrefix = findCommonPrefix(names);
            const additionalChars = commonPrefix.slice(matchPrefix.length);

            if (additionalChars) {
                // Complete the common prefix
                session.inputBuffer = input + additionalChars;
                writeToStream(stream, additionalChars);
            } else {
                // Show all options
                writeToStream(stream, '\n');
                for (const match of matches) {
                    const suffix = match.type === 'directory' ? '/' : '';
                    writeToStream(stream, match.name + suffix + '  ');
                }
                writeToStream(stream, '\n');
                printPrompt(stream, session);
                writeToStream(stream, session.inputBuffer);
            }
        }
    });
}

/**
 * Find the longest common prefix among strings
 */
function findCommonPrefix(strings: string[]): string {
    if (strings.length === 0) return '';
    if (strings.length === 1) return strings[0];

    let prefix = strings[0];
    for (let i = 1; i < strings.length; i++) {
        while (!strings[i].startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
            if (prefix === '') return '';
        }
    }
    return prefix;
}

/**
 * Handle input data from the stream
 *
 * Buffers input until newline, then processes.
 * If a foreground process is active, input is piped to it instead.
 */
export async function handleInput(
    stream: TTYStream,
    session: Session,
    data: string | Uint8Array,
    config?: TTYConfig,
    echo = true
): Promise<void> {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);

    // If foreground process in raw mode, send everything directly
    if (session.foregroundIO?.mode === 'raw') {
        session.foregroundIO.stdin.write(text);
        return;
    }

    let inEscape = false;
    let escapeBuffer = '';

    for (const char of text) {
        // Handle ANSI escape sequences
        if (char === '\x1b') {
            inEscape = true;
            escapeBuffer = '';
            continue;
        }

        if (inEscape) {
            escapeBuffer += char;
            if (escapeBuffer.length >= 2 && /[A-Za-z~]/.test(char)) {
                inEscape = false;

                // Handle arrow keys for history (only in shell mode when no foreground process)
                if (!session.foregroundIO && session.authenticated && session.mode === 'shell') {
                    if (escapeBuffer === '[A') {
                        handleHistoryUp(stream, session);
                    } else if (escapeBuffer === '[B') {
                        handleHistoryDown(stream, session);
                    }
                } else if (session.foregroundIO) {
                    // Pass escape sequence to foreground process
                    session.foregroundIO.stdin.write('\x1b' + escapeBuffer);
                }
            }
            continue;
        }

        // If foreground process in line mode, use its line buffer
        if (session.foregroundIO?.mode === 'line') {
            // Handle backspace
            if (char === '\x7f' || char === '\x08') {
                if (session.foregroundIO.lineBuffer.length > 0) {
                    session.foregroundIO.lineBuffer = session.foregroundIO.lineBuffer.slice(0, -1);
                    if (echo) {
                        writeToStream(stream, '\b \b');
                    }
                }
                continue;
            }

            // Handle newline - flush to stdin
            if (char === '\n' || char === '\r') {
                if (echo) {
                    writeToStream(stream, '\r\n');
                }
                session.foregroundIO.stdin.write(session.foregroundIO.lineBuffer + '\n');
                session.foregroundIO.lineBuffer = '';
                continue;
            }

            // Accumulate
            session.foregroundIO.lineBuffer += char;
            if (echo) {
                writeToStream(stream, char);
            }
            continue;
        }

        // Default shell input handling (no foreground process)

        // Handle backspace
        if (char === '\x7f' || char === '\x08') {
            if (session.inputBuffer.length > 0) {
                session.inputBuffer = session.inputBuffer.slice(0, -1);
                if (echo) {
                    writeToStream(stream, '\b \b');
                }
            }
            continue;
        }

        // Handle tab - path completion (only in shell mode)
        if (char === '\t' && session.authenticated && session.mode === 'shell') {
            await handleTabCompletion(stream, session);
            continue;
        }

        // Handle newline
        if (char === '\n' || char === '\r') {
            if (echo) {
                writeToStream(stream, '\r\n');
            }
            const line = session.inputBuffer;
            session.inputBuffer = '';
            await processLine(stream, session, line, config);
            continue;
        }

        // Accumulate input
        session.inputBuffer += char;
        if (echo) {
            const passwordStates: string[] = ['AWAITING_PASSWORD', 'REGISTER_PASSWORD', 'REGISTER_CONFIRM'];
            if (!session.authenticated && passwordStates.includes(session.authState)) {
                writeToStream(stream, '*');
            } else {
                writeToStream(stream, char);
            }
        }
    }
}

/**
 * Process a complete input line based on session state
 */
async function processLine(
    stream: TTYStream,
    session: Session,
    line: string,
    config?: TTYConfig
): Promise<void> {
    // Non-authenticated states go to auth handler
    if (!session.authenticated) {
        await handleAuthState(stream, session, line, config);
        return;
    }

    // Route by mode
    if (session.mode === 'ai') {
        const shouldContinue = await processAIInput(stream, session, line);
        if (session.shouldClose) {
            // Full exit from AI mode - save context and close
            await saveAIContext(session);
            await saveHistory(session);
            cleanupAIState(session.id);
            stream.end();
        }
        // If !shouldContinue but !shouldClose, we switched to shell mode
        // Don't cleanup - keep AI state for when we return
        return;
    }

    // Shell mode
    const continueShell = await processShellInput(stream, session, line);

    // Check if exit command requested connection close
    if (session.shouldClose) {
        await saveAIContext(session);
        await saveHistory(session);
        cleanupAIState(session.id);
        stream.end();
        return;
    }

    // If shell mode ended (exit command), we're back in AI mode
    // The prompt is handled by processShellInput/exitShellMode
}

// Re-export for convenience
export { printPrompt } from './auth.js';
export { saveHistory } from './profile.js';
