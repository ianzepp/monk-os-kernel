/**
 * Telnet Server
 *
 * TCP server implementing basic telnet protocol for TTY access.
 * Uses Bun's native socket API.
 *
 * Implements RFC 1073 (NAWS) for terminal size negotiation.
 */

import type { Socket } from 'bun';
import type { Session, TTYStream, TTYConfig } from '@src/lib/tty/types.js';
import { createSession, generateSessionId, unregisterSession } from '@src/lib/tty/types.js';
import { handleInput, sendWelcome, saveHistory, handleInterrupt } from '@src/lib/tty/session-handler.js';
import { autoCoalesce } from '@src/lib/tty/memory.js';
import { terminateDaemon } from '@src/lib/process.js';
import { PassThrough } from 'node:stream';

/**
 * Socket data associated with each connection
 */
interface TelnetSocketData {
    session: Session;
    stream: TelnetStream;
}

/**
 * Resize callback type
 */
type ResizeCallback = (cols: number, rows: number) => void;

/**
 * TTYStream implementation for Telnet connections
 *
 * Implements Node.js TTY-compatible interface for TUI library support.
 */
class TelnetStream implements TTYStream {
    private _isOpen = true;
    private _resizeCallbacks: ResizeCallback[] = [];

    /** Node TTY compatibility */
    readonly isTTY = true as const;

    /** Terminal dimensions (updated via NAWS) */
    columns = 80;
    rows = 24;

    /** Input stream for TUI libraries */
    readonly input: PassThrough;

    constructor(private socket: Socket<TelnetSocketData>) {
        this.input = new PassThrough();
    }

    write(data: string | Uint8Array): void {
        if (!this._isOpen) return;

        try {
            if (typeof data === 'string') {
                this.socket.write(data);
            } else {
                this.socket.write(data);
            }
        } catch {
            this._isOpen = false;
        }
    }

    end(): void {
        this._isOpen = false;
        this.input.end();
        try {
            this.socket.end();
        } catch {
            // Socket may already be closed
        }
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    /**
     * Update terminal size (called when NAWS subnegotiation received)
     */
    setSize(cols: number, rows: number): void {
        if (cols > 0) this.columns = cols;
        if (rows > 0) this.rows = rows;

        // Notify listeners
        for (const callback of this._resizeCallbacks) {
            try {
                callback(this.columns, this.rows);
            } catch {
                // Ignore callback errors
            }
        }
    }

    onResize(callback: ResizeCallback): void {
        this._resizeCallbacks.push(callback);
    }

    offResize(callback: ResizeCallback): void {
        const index = this._resizeCallbacks.indexOf(callback);
        if (index !== -1) {
            this._resizeCallbacks.splice(index, 1);
        }
    }

    /**
     * Push data into the input stream (for TUI libraries to consume)
     */
    pushInput(data: Uint8Array): void {
        if (!this._isOpen) return;
        this.input.write(Buffer.from(data));
    }
}

/**
 * Telnet protocol constants
 */
const TELNET = {
    IAC: 255, // Interpret As Command
    WILL: 251,
    WONT: 252,
    DO: 253,
    DONT: 254,
    SB: 250, // Subnegotiation Begin
    SE: 240, // Subnegotiation End
    ECHO: 1,
    SGA: 3, // Suppress Go Ahead
    NAWS: 31, // Negotiate About Window Size (RFC 1073)
};

export interface TelnetServerHandle {
    stop: () => void;
}

/**
 * Create and start a Telnet server
 *
 * @param config - Server configuration
 * @returns Server instance with stop() method
 */
export function startTelnetServer(config?: TTYConfig): TelnetServerHandle {
    const port = config?.telnetPort ?? 2323;
    const hostname = config?.telnetHost ?? '0.0.0.0';

    const server = Bun.listen<TelnetSocketData>({
        hostname,
        port,

        socket: {
            open(socket) {
                const session = createSession(generateSessionId());
                const stream = new TelnetStream(socket);

                socket.data = { session, stream };

                // Send telnet negotiation: WILL ECHO, WILL SGA, DO NAWS
                socket.write(
                    new Uint8Array([
                        TELNET.IAC,
                        TELNET.WILL,
                        TELNET.ECHO,
                        TELNET.IAC,
                        TELNET.WILL,
                        TELNET.SGA,
                        TELNET.IAC,
                        TELNET.DO,
                        TELNET.NAWS,
                    ])
                );

                // Send welcome message
                sendWelcome(stream, config);

                console.info(
                    `Telnet: New connection from ${socket.remoteAddress} (session ${session.id})`
                );
            },

            async data(socket, data) {
                const { session, stream } = socket.data;

                // Parse telnet protocol, extract NAWS, and filter to user data
                const { userData, resize } = parseTelnetData(data);

                // Handle NAWS window size update
                if (resize) {
                    stream.setSize(resize.cols, resize.rows);
                }

                if (userData.length === 0) return;

                // Check for Ctrl+C or Ctrl+D
                for (const byte of userData) {
                    if (byte === 0x03) {
                        // CTRL+C - try to interrupt foreground command
                        const handled = handleInterrupt(stream, session);
                        if (!handled) {
                            console.info(`Telnet: Session ${session.id} disconnect via Ctrl+C`);
                            socket.end();
                        }
                        return;
                    }
                    if (byte === 0x04) {
                        // CTRL+D - behavior depends on mode
                        if (session.foregroundAbort) {
                            session.foregroundAbort.abort();
                            session.foregroundAbort = null;
                        }

                        // In shell mode, return to AI mode instead of disconnecting
                        if (session.authenticated && session.mode === 'shell') {
                            const { exitShellMode } = await import('@src/lib/tty/shell-mode.js');
                            await exitShellMode(stream, session);
                            return;
                        }

                        // In AI mode or unauthenticated, disconnect
                        console.info(`Telnet: Session ${session.id} disconnect via Ctrl+D`);
                        socket.end();
                        return;
                    }
                }

                // Push to input stream for TUI libraries
                stream.pushInput(userData);

                // Handle input via session handler
                try {
                    await handleInput(
                        stream,
                        session,
                        userData,
                        config,
                        session.state !== 'AWAITING_PASSWORD'
                    );
                } catch (err) {
                    console.error(`Telnet: Error in session ${session.id}:`, err);
                    stream.write(`\r\nInternal error\r\n`);
                }
            },

            async close(socket) {
                const { session, stream } = socket.data;
                console.info(`Telnet: Session ${session.id} closed`);

                // Abort any running foreground command
                if (session.foregroundAbort) {
                    session.foregroundAbort.abort();
                    session.foregroundAbort = null;
                }

                // Auto-coalesce STM (silent - no output on disconnect)
                await autoCoalesce(session);

                // End the input stream
                stream.input.end();

                // Unregister from global session registry and terminate shell process
                if (session.pid) {
                    unregisterSession(session.pid);
                    try {
                        await terminateDaemon(session.pid, 0);
                    } catch {
                        // Ignore termination errors
                    }
                }

                // Save command history
                await saveHistory(session);

                // Run cleanup handlers
                for (const cleanup of session.cleanupHandlers) {
                    try {
                        cleanup();
                    } catch {
                        // Ignore cleanup errors
                    }
                }
            },

            error(socket, error) {
                console.error(
                    `Telnet: Socket error for session ${socket.data?.session?.id}:`,
                    error
                );
            },
        },
    });

    console.info(`Telnet server listening on ${hostname}:${port}`);

    return {
        stop: () => {
            server.stop();
            console.info('Telnet server stopped');
        },
    };
}

/**
 * Result of parsing telnet data
 */
interface TelnetParseResult {
    /** Filtered user data (telnet commands removed) */
    userData: Uint8Array;
    /** Window size if NAWS subnegotiation was received */
    resize?: { cols: number; rows: number };
}

/**
 * Parse telnet data, extract NAWS window size, and filter to user data
 *
 * Handles RFC 1073 NAWS subnegotiation:
 * IAC SB NAWS <width-high> <width-low> <height-high> <height-low> IAC SE
 */
function parseTelnetData(data: Buffer): TelnetParseResult {
    const result: number[] = [];
    let resize: { cols: number; rows: number } | undefined;
    let i = 0;

    while (i < data.length) {
        const byte = data[i];

        // Skip NUL bytes
        if (byte === 0) {
            i++;
            continue;
        }

        // Handle telnet IAC sequences
        if (byte === TELNET.IAC) {
            if (i + 1 >= data.length) break;

            const cmd = data[i + 1];

            // IAC IAC = literal 255
            if (cmd === TELNET.IAC) {
                result.push(255);
                i += 2;
                continue;
            }

            // Subnegotiation: IAC SB <option> <data...> IAC SE
            if (cmd === TELNET.SB) {
                // Find IAC SE to end subnegotiation
                let seIndex = i + 2;
                while (seIndex < data.length - 1) {
                    if (data[seIndex] === TELNET.IAC && data[seIndex + 1] === TELNET.SE) {
                        break;
                    }
                    seIndex++;
                }

                // Parse NAWS if that's the option
                if (i + 2 < data.length && data[i + 2] === TELNET.NAWS) {
                    // NAWS format: IAC SB NAWS <w-hi> <w-lo> <h-hi> <h-lo> IAC SE
                    if (i + 6 <= seIndex) {
                        const cols = (data[i + 3] << 8) | data[i + 4];
                        const rows = (data[i + 5] << 8) | data[i + 6];
                        resize = { cols, rows };
                    }
                }

                // Skip past IAC SE
                i = seIndex + 2;
                continue;
            }

            // WILL/WONT/DO/DONT + option
            if (cmd >= TELNET.WILL && cmd <= TELNET.DONT) {
                i += 3;
                continue;
            }

            // Other command
            i += 2;
            continue;
        }

        result.push(byte);
        i++;
    }

    return {
        userData: new Uint8Array(result),
        resize,
    };
}
