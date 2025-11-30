/**
 * SSH Server
 *
 * SSH server using ssh2 library.
 * More secure than telnet - encrypted, supports key auth.
 */

import { Server, type ServerChannel, type Connection } from 'ssh2';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { generateKeyPairSync } from 'crypto';
import { PassThrough } from 'node:stream';
import type { Session, TTYStream, TTYConfig } from '@src/lib/tty/types.js';
import { createSession, generateSessionId, unregisterSession } from '@src/lib/tty/types.js';
import { handleInput, printPrompt, writeToStream, saveHistory, handleInterrupt } from '@src/lib/tty/session-handler.js';
import { autoCoalesce } from '@src/lib/tty/memory.js';
import { login } from '@src/lib/auth.js';
import { terminateDaemon } from '@src/lib/process.js';

/**
 * Resize callback type
 */
type ResizeCallback = (cols: number, rows: number) => void;

/**
 * TTYStream implementation for SSH channels
 *
 * Implements Node.js TTY-compatible interface for TUI library support.
 */
class SSHStream implements TTYStream {
    private _isOpen = true;
    private _resizeCallbacks: ResizeCallback[] = [];

    /** Node TTY compatibility */
    readonly isTTY = true as const;

    /** Terminal dimensions (updated via PTY resize) */
    columns = 80;
    rows = 24;

    /** Input stream for TUI libraries */
    readonly input: PassThrough;

    constructor(private channel: ServerChannel) {
        this.input = new PassThrough();

        channel.on('close', () => {
            this._isOpen = false;
            this.input.end();
        });
    }

    write(data: string | Uint8Array): void {
        if (!this._isOpen) return;
        this.channel.write(data);
    }

    end(): void {
        this._isOpen = false;
        this.input.end();
        this.channel.end();
    }

    get isOpen(): boolean {
        return this._isOpen;
    }

    /**
     * Update terminal size (called on PTY resize)
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
    pushInput(data: Buffer): void {
        if (!this._isOpen) return;
        this.input.write(data);
    }
}

/**
 * Generate a host key if none exists
 */
function getOrCreateHostKey(keyPath?: string): Buffer {
    const defaultPath = './ssh_host_key';
    const path = keyPath || defaultPath;

    if (existsSync(path)) {
        return readFileSync(path);
    }

    // Generate new RSA key pair
    console.info('Generating SSH host key...');
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
        },
        publicKeyEncoding: {
            type: 'pkcs1',
            format: 'pem',
        },
    });

    writeFileSync(path, privateKey);
    console.info(`SSH host key saved to ${path}`);
    return Buffer.from(privateKey);
}

export interface SSHServerHandle {
    stop: () => void;
}

/**
 * Create and start an SSH server
 *
 * @param config - Server configuration
 * @returns Server instance with stop() method
 */
export function startSSHServer(config?: TTYConfig): SSHServerHandle {
    const port = config?.sshPort ?? 2222;
    const host = config?.sshHost ?? '0.0.0.0';

    const hostKey = getOrCreateHostKey(config?.sshHostKey);

    const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
        let session: Session | null = null;

        client.on('authentication', async (ctx) => {
            // Parse username as user@tenant
            const atIndex = ctx.username.indexOf('@');
            if (atIndex === -1) {
                ctx.reject(['password']);
                return;
            }

            const username = ctx.username.slice(0, atIndex);
            const tenant = ctx.username.slice(atIndex + 1);

            if (!username || !tenant) {
                ctx.reject(['password']);
                return;
            }

            if (ctx.method === 'password') {
                // Verify against Monk auth
                try {
                    const result = await login({
                        tenant,
                        username,
                        password: ctx.password,
                    });

                    if (result.success) {
                        session = createSession(generateSessionId());
                        session.username = username;
                        session.tenant = tenant;
                        session.systemInit = result.systemInit;
                        session.state = 'AUTHENTICATED';
                        session.env['USER'] = result.user.username;
                        session.env['TENANT'] = result.user.tenant;
                        session.env['ACCESS'] = result.user.access;
                        ctx.accept();
                    } else {
                        ctx.reject(['password']);
                    }
                } catch {
                    ctx.reject(['password']);
                }
            } else if (ctx.method === 'none') {
                // Try passwordless login
                try {
                    const result = await login({
                        tenant,
                        username,
                    });

                    if (result.success) {
                        session = createSession(generateSessionId());
                        session.username = username;
                        session.tenant = tenant;
                        session.systemInit = result.systemInit;
                        session.state = 'AUTHENTICATED';
                        session.env['USER'] = result.user.username;
                        session.env['TENANT'] = result.user.tenant;
                        session.env['ACCESS'] = result.user.access;
                        ctx.accept();
                    } else {
                        // Require password
                        ctx.reject(['password']);
                    }
                } catch {
                    ctx.reject(['password']);
                }
            } else {
                ctx.reject(['password']);
            }
        });

        client.on('ready', () => {
            console.info(`SSH: Client authenticated (session ${session?.id})`);

            client.on('session', (accept) => {
                const sshSession = accept();

                // Track stream for resize events
                let activeStream: SSHStream | null = null;

                sshSession.on('pty', (accept, _reject, info) => {
                    accept?.();
                    // Set initial size if stream exists
                    if (activeStream && info.cols && info.rows) {
                        activeStream.setSize(info.cols, info.rows);
                    }
                });

                sshSession.on('window-change', (_accept, _reject, info) => {
                    // Handle terminal resize
                    if (activeStream && info.cols && info.rows) {
                        activeStream.setSize(info.cols, info.rows);
                    }
                });

                sshSession.on('shell', (accept) => {
                    const channel = accept();
                    if (!session) return;

                    const stream = new SSHStream(channel);
                    activeStream = stream;

                    // Already authenticated via SSH - show welcome and prompt
                    writeToStream(stream, '\n');
                    writeToStream(stream, `Welcome ${session.username}@${session.tenant}!\n`);
                    writeToStream(stream, `Access level: ${session.env['ACCESS']}\n`);
                    writeToStream(stream, `Type 'help' for available commands.\n\n`);
                    printPrompt(stream, session);

                    channel.on('data', async (data: Buffer) => {
                        // Push to input stream for TUI libraries
                        stream.pushInput(data);

                        const text = data.toString();

                        // Handle Ctrl+C
                        if (text.includes('\x03')) {
                            const handled = handleInterrupt(stream, session!);
                            if (!handled) {
                                writeToStream(stream, '\nConnection closed.\n');
                                stream.end();
                            }
                            return;
                        }

                        // Handle Ctrl+D - abort any running command, then disconnect
                        if (text.includes('\x04')) {
                            if (session!.foregroundAbort) {
                                session!.foregroundAbort.abort();
                                session!.foregroundAbort = null;
                            }
                            writeToStream(stream, '\nConnection closed.\n');
                            stream.end();
                            return;
                        }

                        try {
                            await handleInput(stream, session!, text, config, true);
                        } catch (err) {
                            console.error(`SSH: Error in session ${session?.id}:`, err);
                            writeToStream(stream, '\nInternal error\n');
                        }
                    });

                    channel.on('close', () => {
                        console.info(`SSH: Session ${session?.id} channel closed`);
                        activeStream = null;
                        // Run cleanup handlers
                        for (const cleanup of session!.cleanupHandlers) {
                            try {
                                cleanup();
                            } catch {
                                // Ignore cleanup errors
                            }
                        }
                    });
                });

                // Handle exec requests (single commands)
                sshSession.on('exec', async (accept, _reject, info) => {
                    const channel = accept();
                    if (!session) return;

                    const stream = new SSHStream(channel);

                    // Execute the command directly
                    session.inputBuffer = info.command;

                    try {
                        await handleInput(stream, session, '\n', config, false);
                    } catch (err) {
                        writeToStream(
                            stream,
                            `Error: ${err instanceof Error ? err.message : String(err)}\n`
                        );
                    }

                    // Close after output
                    setTimeout(() => stream.end(), 100);
                });
            });
        });

        client.on('error', (err) => {
            // Ignore common errors
            if (!err.message?.includes('ECONNRESET')) {
                console.error('SSH client error:', err.message);
            }
        });

        client.on('close', async () => {
            if (session) {
                console.info(`SSH: Session ${session.id} closed`);

                // Abort any running foreground command
                if (session.foregroundAbort) {
                    session.foregroundAbort.abort();
                    session.foregroundAbort = null;
                }

                // Auto-coalesce STM (silent - no output on disconnect)
                await autoCoalesce(session);

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
            }
        });
    });

    server.listen(port, host, () => {
        console.info(`SSH server listening on ${host}:${port}`);
    });

    return {
        stop: () => {
            server.close();
            console.info('SSH server stopped');
        },
    };
}
