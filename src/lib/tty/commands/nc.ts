/**
 * nc - Netcat: arbitrary TCP connections
 *
 * Usage:
 *   nc [options] host port
 *   nc -l [options] port          (listen mode - not implemented)
 *
 * Options:
 *   -z          Zero-I/O mode (just scan if port is open)
 *   -w TIMEOUT  Timeout in seconds (default: 10)
 *   -v          Verbose output
 *
 * Examples:
 *   nc -z localhost 3000          Check if port is open
 *   nc localhost 80               Connect to port 80
 *   echo "GET /" | nc localhost 80    Send HTTP request
 *   nc -zv localhost 3000-3010   Scan port range (future)
 */

import type { CommandHandler } from './shared.js';
import { connect, type Socket } from 'node:net';

export const nc: CommandHandler = async (_session, _fs, args, io) => {
    // Parse options
    let zeroIO = false;
    let verbose = false;
    let timeout = 10;
    const positional: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-z') {
            zeroIO = true;
        } else if (arg === '-v') {
            verbose = true;
        } else if (arg === '-w' && args[i + 1]) {
            timeout = parseInt(args[++i], 10);
            if (isNaN(timeout) || timeout <= 0) {
                io.stderr.write('nc: invalid timeout\n');
                return 1;
            }
        } else if (arg === '-l') {
            io.stderr.write('nc: listen mode not implemented\n');
            return 1;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length < 2) {
        io.stderr.write('nc: missing host and/or port\n');
        io.stderr.write('Usage: nc [-zv] [-w timeout] host port\n');
        return 1;
    }

    const host = positional[0];
    const port = parseInt(positional[1], 10);

    if (isNaN(port) || port < 1 || port > 65535) {
        io.stderr.write(`nc: invalid port: ${positional[1]}\n`);
        return 1;
    }

    // Zero-I/O mode: just check if port is open
    if (zeroIO) {
        return scanPort(host, port, timeout, verbose, io);
    }

    // Interactive/pipe mode: connect and transfer data
    return connectAndTransfer(host, port, timeout, verbose, io);
};

/**
 * Scan if a port is open (nc -z)
 */
async function scanPort(
    host: string,
    port: number,
    timeout: number,
    verbose: boolean,
    io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
): Promise<number> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: timeout * 1000 });
        let resolved = false;

        const cleanup = (code: number) => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(code);
        };

        socket.on('connect', () => {
            if (verbose) {
                io.stderr.write(`Connection to ${host} ${port} port [tcp/*] succeeded!\n`);
            }
            cleanup(0);
        });

        socket.on('error', (err) => {
            if (verbose) {
                io.stderr.write(`nc: connect to ${host} port ${port} (tcp) failed: ${err.message}\n`);
            }
            cleanup(1);
        });

        socket.on('timeout', () => {
            if (verbose) {
                io.stderr.write(`nc: connect to ${host} port ${port} (tcp) timed out\n`);
            }
            cleanup(1);
        });
    });
}

/**
 * Connect and transfer data bidirectionally
 */
async function connectAndTransfer(
    host: string,
    port: number,
    timeout: number,
    verbose: boolean,
    io: {
        stdin: NodeJS.ReadableStream;
        stdout: NodeJS.WritableStream;
        stderr: NodeJS.WritableStream;
        signal?: AbortSignal;
    }
): Promise<number> {
    return new Promise((resolve) => {
        let socket: Socket;
        let resolved = false;

        const cleanup = (code: number) => {
            if (resolved) return;
            resolved = true;
            if (socket) socket.destroy();
            resolve(code);
        };

        // Handle abort signal
        if (io.signal) {
            io.signal.addEventListener('abort', () => {
                cleanup(130);
            });
        }

        socket = connect({ host, port, timeout: timeout * 1000 });

        socket.on('connect', () => {
            if (verbose) {
                io.stderr.write(`Connected to ${host}:${port}\n`);
            }

            // Pipe stdin to socket
            io.stdin.on('data', (chunk) => {
                if (!resolved) {
                    socket.write(chunk);
                }
            });

            io.stdin.on('end', () => {
                if (!resolved) {
                    socket.end();
                }
            });

            // Pipe socket to stdout
            socket.on('data', (chunk) => {
                io.stdout.write(chunk);
            });
        });

        socket.on('end', () => {
            if (verbose) {
                io.stderr.write('Connection closed by remote host\n');
            }
            cleanup(0);
        });

        socket.on('close', () => {
            cleanup(0);
        });

        socket.on('error', (err) => {
            io.stderr.write(`nc: ${err.message}\n`);
            cleanup(1);
        });

        socket.on('timeout', () => {
            io.stderr.write(`nc: connection timed out\n`);
            cleanup(1);
        });
    });
}
