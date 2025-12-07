import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BunNetworkDevice } from '@src/hal/index.js';
import { ETIMEDOUT, EBADF } from '@src/hal/errors.js';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Get a random available port for testing.
 * Uses a range that's unlikely to conflict with common services.
 */
function getTestPort(): number {
    return 49152 + Math.floor(Math.random() * 16000);
}

describe('Network Device', () => {
    describe('BunNetworkDevice', () => {
        let network: BunNetworkDevice;

        beforeEach(() => {
            network = new BunNetworkDevice();
        });

        // =====================================================================
        // TCP LISTENER
        // =====================================================================

        describe('listen', () => {
            it('should create a TCP listener on specified port', async () => {
                const testPort = getTestPort();
                const listener = await network.listen(testPort);

                try {
                    const addr = listener.addr();

                    expect(addr.hostname).toBe('0.0.0.0');
                    expect(addr.port).toBe(testPort);
                }
                finally {
                    await listener.close();
                }
            });

            it('should create listener with custom hostname', async () => {
                const testPort = getTestPort();
                const listener = await network.listen(testPort, { hostname: '127.0.0.1' });

                try {
                    const addr = listener.addr();

                    expect(addr.hostname).toBe('127.0.0.1');
                }
                finally {
                    await listener.close();
                }
            });

            it('should accept incoming connections', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    // Connect client in background
                    const clientPromise = network.connect('127.0.0.1', port);

                    // Accept on server side
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    expect(serverSocket).toBeDefined();
                    expect(clientSocket).toBeDefined();

                    await serverSocket.close();
                    await clientSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should queue multiple connections', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    // Connect multiple clients
                    const client1Promise = network.connect('127.0.0.1', port);
                    const client2Promise = network.connect('127.0.0.1', port);

                    // Wait for connections to establish
                    const [client1, client2] = await Promise.all([client1Promise, client2Promise]);

                    // Accept both
                    const server1 = await listener.accept();
                    const server2 = await listener.accept();

                    expect(server1).toBeDefined();
                    expect(server2).toBeDefined();

                    await Promise.all([
                        server1.close(),
                        server2.close(),
                        client1.close(),
                        client2.close(),
                    ]);
                }
                finally {
                    await listener.close();
                }
            });

            it('should timeout on accept if no connections', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    await expect(listener.accept({ timeout: 50 })).rejects.toThrow('ETIMEDOUT');
                }
                finally {
                    await listener.close();
                }
            });

            it('should throw after listener is closed', async () => {
                const port = getTestPort();
                const listener = await network.listen(port);

                await listener.close();

                await expect(listener.accept()).rejects.toThrow('Listener closed');
            });

            it('should support AsyncDisposable', async () => {
                const port = getTestPort();

                {
                    await using listener = await network.listen(port);

                    expect(listener.addr().port).toBe(port);
                }

                // After scope exit, listener should be closed
                // Attempting to listen on same port should succeed (port released)
                const listener2 = await network.listen(port);

                await listener2.close();
            });

            it('should be idempotent on close', async () => {
                const port = getTestPort();
                const listener = await network.listen(port);

                await listener.close();
                await listener.close(); // Should not throw
            });
        });

        // =====================================================================
        // TCP CLIENT
        // =====================================================================

        describe('connect', () => {
            it('should connect to TCP server', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const socket = await network.connect('127.0.0.1', port);

                    expect(socket).toBeDefined();

                    const serverSocket = await acceptPromise;

                    await socket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should timeout on connect if server unreachable', async () => {
                // Use a port that's unlikely to have a listener
                // Note: This test may be flaky depending on network conditions
                await expect(
                    network.connect('127.0.0.1', 59999, { timeout: 100 }),
                ).rejects.toThrow();
            });

            it('should return socket with valid stat', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    const clientStat = clientSocket.stat();
                    const serverStat = serverSocket.stat();

                    // Client should see server's port as remote
                    expect(clientStat.remotePort).toBe(port);
                    expect(clientStat.remoteAddr).toBe('127.0.0.1');

                    // Server should see client's port as remote
                    expect(serverStat.localPort).toBe(port);

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });
        });

        // =====================================================================
        // SOCKET READ/WRITE
        // =====================================================================

        describe('socket read/write', () => {
            it('should write and read data', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    // Client writes, server reads
                    const testData = new TextEncoder().encode('hello world');

                    await clientSocket.write(testData);
                    const received = await serverSocket.read();

                    expect(new TextDecoder().decode(received)).toBe('hello world');

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should handle bidirectional communication', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    // Client sends
                    await clientSocket.write(new TextEncoder().encode('ping'));
                    const pingData = await serverSocket.read();

                    expect(new TextDecoder().decode(pingData)).toBe('ping');

                    // Server responds
                    await serverSocket.write(new TextEncoder().encode('pong'));
                    const pongData = await clientSocket.read();

                    expect(new TextDecoder().decode(pongData)).toBe('pong');

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should return EOF when peer closes', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    // Close client
                    await clientSocket.close();

                    // Server should get EOF
                    const data = await serverSocket.read();

                    expect(data.length).toBe(0);

                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should timeout on read if no data', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    // Read with short timeout - no data sent
                    await expect(serverSocket.read({ timeout: 50 })).rejects.toBeInstanceOf(ETIMEDOUT);

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should throw EBADF on write after close', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    await clientSocket.close();

                    // Write after close should throw
                    await expect(
                        clientSocket.write(new TextEncoder().encode('test')),
                    ).rejects.toBeInstanceOf(EBADF);

                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should support AsyncDisposable on sockets', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();

                    {
                        await using clientSocket = await network.connect('127.0.0.1', port);
                        await using serverSocket = await acceptPromise;

                        await clientSocket.write(new TextEncoder().encode('test'));
                        const data = await serverSocket.read();

                        expect(new TextDecoder().decode(data)).toBe('test');
                    }

                    // Sockets closed automatically after scope
                }
                finally {
                    await listener.close();
                }
            });

            it('should buffer data arriving before read', async () => {
                const port = getTestPort();
                const listener = await network.listen(port, { hostname: '127.0.0.1' });

                try {
                    const acceptPromise = listener.accept();
                    const clientSocket = await network.connect('127.0.0.1', port);
                    const serverSocket = await acceptPromise;

                    // Write data before reading
                    await clientSocket.write(new TextEncoder().encode('chunk1'));
                    await clientSocket.write(new TextEncoder().encode('chunk2'));

                    // Small delay to ensure data is buffered
                    await Bun.sleep(20);

                    // Read all available data (TCP may coalesce writes)
                    const chunks: string[] = [];
                    const data1 = await serverSocket.read();

                    chunks.push(new TextDecoder().decode(data1));

                    // Try to read more if there's more data (use timeout to avoid blocking)
                    try {
                        const data2 = await serverSocket.read({ timeout: 50 });

                        if (data2.length > 0) {
                            chunks.push(new TextDecoder().decode(data2));
                        }
                    }
                    catch {
                        // Timeout is OK - data may have arrived in one chunk
                    }

                    // All data should be received, order preserved
                    expect(chunks.join('')).toBe('chunk1chunk2');

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });
        });

        // =====================================================================
        // UNIX SOCKETS
        // =====================================================================

        describe('unix sockets', () => {
            let socketPath: string;

            beforeEach(() => {
                // Generate unique socket path for each test
                socketPath = join(tmpdir(), `monk-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
            });

            afterEach(() => {
                // Clean up socket file
                if (existsSync(socketPath)) {
                    rmSync(socketPath);
                }
            });

            it('should create Unix socket listener', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const addr = listener.addr();

                    expect(addr.hostname).toBe('unix');
                    expect(addr.port).toBe(0);
                    expect(existsSync(socketPath)).toBe(true);
                }
                finally {
                    await listener.close();
                }
            });

            it('should accept connections on Unix socket', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    // Connect via Unix socket (port=0 indicates Unix socket)
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    expect(serverSocket).toBeDefined();
                    expect(clientSocket).toBeDefined();

                    await serverSocket.close();
                    await clientSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should support read/write on Unix socket', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    // Write from client
                    await clientSocket.write(new TextEncoder().encode('unix hello'));
                    const received = await serverSocket.read();

                    expect(new TextDecoder().decode(received)).toBe('unix hello');

                    await serverSocket.close();
                    await clientSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should support bidirectional communication', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    // Client sends request
                    await clientSocket.write(new TextEncoder().encode('request'));
                    const request = await serverSocket.read();

                    expect(new TextDecoder().decode(request)).toBe('request');

                    // Server sends response
                    await serverSocket.write(new TextEncoder().encode('response'));
                    const response = await clientSocket.read();

                    expect(new TextDecoder().decode(response)).toBe('response');

                    await serverSocket.close();
                    await clientSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should return EOF when peer closes', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    // Close client side
                    await clientSocket.close();

                    // Server should get EOF
                    const data = await serverSocket.read();

                    expect(data.length).toBe(0);

                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should handle multiple connections', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    // Connect multiple clients
                    const client1Promise = network.connect(socketPath, 0);
                    const client2Promise = network.connect(socketPath, 0);

                    const [client1, client2] = await Promise.all([client1Promise, client2Promise]);

                    // Accept both
                    const server1 = await listener.accept();
                    const server2 = await listener.accept();

                    // Send different data on each connection
                    await client1.write(new TextEncoder().encode('client1'));
                    await client2.write(new TextEncoder().encode('client2'));

                    const data1 = await server1.read();
                    const data2 = await server2.read();

                    // Each server socket should receive from its respective client
                    const texts = [
                        new TextDecoder().decode(data1),
                        new TextDecoder().decode(data2),
                    ].sort();

                    expect(texts).toEqual(['client1', 'client2']);

                    await Promise.all([
                        server1.close(),
                        server2.close(),
                        client1.close(),
                        client2.close(),
                    ]);
                }
                finally {
                    await listener.close();
                }
            });

            it('should timeout on accept if no connections', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    await expect(listener.accept({ timeout: 50 })).rejects.toThrow('ETIMEDOUT');
                }
                finally {
                    await listener.close();
                }
            });

            it('should fail to connect to non-existent socket', async () => {
                const badPath = join(tmpdir(), 'non-existent-socket.sock');

                await expect(network.connect(badPath, 0)).rejects.toThrow();
            });

            it('should throw EBADF on write after close', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    await clientSocket.close();

                    await expect(
                        clientSocket.write(new TextEncoder().encode('test')),
                    ).rejects.toBeInstanceOf(EBADF);

                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should timeout on read if no data', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    // Read with short timeout - no data sent
                    await expect(serverSocket.read({ timeout: 50 })).rejects.toBeInstanceOf(ETIMEDOUT);

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should handle larger messages', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                try {
                    const clientPromise = network.connect(socketPath, 0);
                    const serverSocket = await listener.accept();
                    const clientSocket = await clientPromise;

                    // Create 8KB of data (reasonable for single message test)
                    const testData = new Uint8Array(8 * 1024);

                    for (let i = 0; i < testData.length; i++) {
                        testData[i] = i % 256;
                    }

                    // Send data
                    await clientSocket.write(testData);

                    // Small delay to ensure data arrives
                    await Bun.sleep(20);

                    // Read data (may come in one or multiple chunks)
                    const chunks: Uint8Array[] = [];
                    let totalReceived = 0;

                    // Read first chunk (should have data)
                    const firstChunk = await serverSocket.read();

                    chunks.push(firstChunk);
                    totalReceived += firstChunk.length;

                    // Try to read more if available
                    while (totalReceived < testData.length) {
                        try {
                            const chunk = await serverSocket.read({ timeout: 50 });

                            if (chunk.length === 0) {
                                break;
                            }

                            chunks.push(chunk);
                            totalReceived += chunk.length;
                        }
                        catch {
                            // Timeout - no more data
                            break;
                        }
                    }

                    // Concatenate all chunks
                    const received = new Uint8Array(totalReceived);
                    let offset = 0;

                    for (const chunk of chunks) {
                        received.set(chunk, offset);
                        offset += chunk.length;
                    }

                    expect(received.length).toBe(testData.length);
                    expect(received).toEqual(testData);

                    await clientSocket.close();
                    await serverSocket.close();
                }
                finally {
                    await listener.close();
                }
            });

            it('should support AsyncDisposable', async () => {
                {
                    await using listener = await network.listen(0, { unix: socketPath });

                    expect(existsSync(socketPath)).toBe(true);

                    const clientPromise = network.connect(socketPath, 0);

                    await using serverSocket = await listener.accept();
                    await using clientSocket = await clientPromise;

                    await clientSocket.write(new TextEncoder().encode('test'));
                    const data = await serverSocket.read();

                    expect(new TextDecoder().decode(data)).toBe('test');
                }

                // Resources cleaned up after scope
            });

            it('should throw after listener is closed', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                await listener.close();

                await expect(listener.accept()).rejects.toThrow('Listener closed');
            });

            it('should be idempotent on close', async () => {
                const listener = await network.listen(0, { unix: socketPath });

                await listener.close();
                await listener.close(); // Should not throw
            });
        });

        // =====================================================================
        // HTTP SERVER
        // =====================================================================

        describe('serve', () => {
            it('should create HTTP server', async () => {
                const port = getTestPort();
                const server = await network.serve(port, () => new Response('OK'));

                try {
                    const addr = server.addr();

                    expect(addr.port).toBe(port);
                }
                finally {
                    await server.close();
                }
            });

            it('should handle HTTP requests', async () => {
                const port = getTestPort();
                const server = await network.serve(port, req => {
                    const url = new URL(req.url);

                    return new Response(`Hello ${url.pathname}`);
                });

                try {
                    const response = await fetch(`http://127.0.0.1:${port}/world`);
                    const text = await response.text();

                    expect(text).toBe('Hello /world');
                }
                finally {
                    await server.close();
                }
            });

            it('should handle POST requests with body', async () => {
                const port = getTestPort();
                const server = await network.serve(port, async req => {
                    const body = await req.text();

                    return new Response(`Received: ${body}`);
                });

                try {
                    const response = await fetch(`http://127.0.0.1:${port}/`, {
                        method: 'POST',
                        body: 'test data',
                    });
                    const text = await response.text();

                    expect(text).toBe('Received: test data');
                }
                finally {
                    await server.close();
                }
            });

            it('should handle JSON requests', async () => {
                const port = getTestPort();
                const server = await network.serve(port, async req => {
                    const data = await req.json();

                    return Response.json({ echo: data });
                });

                try {
                    const response = await fetch(`http://127.0.0.1:${port}/`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: 'hello' }),
                    });
                    const json = await response.json();

                    expect(json).toEqual({ echo: { message: 'hello' } });
                }
                finally {
                    await server.close();
                }
            });

            it('should support custom hostname', async () => {
                const port = getTestPort();
                const server = await network.serve(
                    port,
                    () => new Response('OK'),
                    { hostname: '127.0.0.1' },
                );

                try {
                    const addr = server.addr();

                    expect(addr.hostname).toBe('127.0.0.1');
                }
                finally {
                    await server.close();
                }
            });

            it('should support AsyncDisposable', async () => {
                const port = getTestPort();

                {
                    await using _server = await network.serve(port, () => new Response('OK'));

                    const response = await fetch(`http://127.0.0.1:${port}/`);

                    expect(await response.text()).toBe('OK');
                }

                // Server closed after scope exit
            });

            it('should be idempotent on close', async () => {
                const port = getTestPort();
                const server = await network.serve(port, () => new Response('OK'));

                await server.close();
                await server.close(); // Should not throw
            });
        });

        // =====================================================================
        // WEBSOCKET
        // =====================================================================

        describe('websocket', () => {
            it('should upgrade HTTP to WebSocket', async () => {
                const port = getTestPort();
                let wsOpened = false;
                const _wsMessage = '';

                const server = await network.serve(
                    port,
                    (req, upgradeServer) => {
                        if (req.headers.get('upgrade') === 'websocket') {
                            const success = upgradeServer?.upgrade(req, { userId: '123' });

                            if (success) {
                                return undefined;
                            }
                        }

                        return new Response('Not a WebSocket request', { status: 400 });
                    },
                    {
                        websocket: {
                            open(ws) {
                                wsOpened = true;
                                ws.send('welcome');
                            },
                            message(ws, msg) {
                                wsMessage = String(msg);
                                ws.send(`echo: ${msg}`);
                            },
                        },
                    },
                );

                try {
                    // Connect WebSocket client
                    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);

                    const messages: string[] = [];

                    await new Promise<void>((resolve, reject) => {
                        ws.onopen = () => {
                            ws.send('hello');
                        };

                        ws.onmessage = event => {
                            messages.push(String(event.data));
                            if (messages.length === 2) {
                                ws.close();
                            }
                        };

                        ws.onclose = () => resolve();
                        ws.onerror = reject;
                    });

                    expect(wsOpened).toBe(true);
                    expect(messages).toContain('welcome');
                    expect(messages).toContain('echo: hello');
                }
                finally {
                    await server.close();
                }
            });
        });
    });
});
