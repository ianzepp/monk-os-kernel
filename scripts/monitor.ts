/**
 * Monitor - UDP debug message listener
 *
 * Listens for UDP messages on port 9999 and prints them line by line.
 * Used for debugging Prior and other Monk OS processes.
 *
 * Usage: bun run monitor
 */

import { createSocket } from 'dgram';

const PORT = 9999;

const socket = createSocket('udp4');

socket.on('message', (msg, rinfo) => {
    const timestamp = new Date().toISOString().slice(11, 23);
    const message = msg.toString().trim();
    console.log(`[${timestamp}] ${message}`);
});

socket.on('error', (err) => {
    console.error(`Monitor error: ${err.message}`);
    socket.close();
    process.exit(1);
});

socket.on('listening', () => {
    const addr = socket.address();
    console.log(`Monitor listening on UDP ${addr.address}:${addr.port}`);
    console.log('Waiting for debug messages...\n');
});

socket.bind(PORT);
