/**
 * Monk OS Telnet Daemon
 *
 * Socket-activated telnet service. Each connection spawns a new instance
 * with the socket as fd 0/1/2 (like inetd).
 *
 * This is a minimal implementation that:
 * - Sends a welcome banner
 * - Spawns a shell with the socket as stdio
 * - Waits for the shell to exit
 *
 * Telnet protocol negotiation (IAC sequences) is not implemented yet.
 * For now, clients should use raw TCP mode or a simple telnet client.
 */

import {
    read,
    write,
    spawn,
    wait,
    exit,
    getenv,
} from '/lib/process';

// Telnet commands (for future use)
const TELNET = {
    IAC: 255,   // Interpret As Command
    WILL: 251,
    WONT: 252,
    DO: 253,
    DONT: 254,
    SB: 250,    // Subnegotiation Begin
    SE: 240,    // Subnegotiation End
    ECHO: 1,
    SGA: 3,     // Suppress Go Ahead
    NAWS: 31,   // Negotiate About Window Size
};

/**
 * Main entry point.
 */
async function main(): Promise<void> {
    try {
        // Send welcome banner
        const hostname = await getenv('HOSTNAME') ?? 'monk';
        const banner = `\r\nWelcome to ${hostname}\r\n\r\n`;
        await write(0, new TextEncoder().encode(banner));

        // Send telnet negotiation (optional - clients may ignore)
        await sendTelnetNegotiation();

        // Spawn shell with inherited stdio (fd 0/1/2 = socket)
        const shellPid = await spawn('./src/bin/shell.ts', {
            args: ['shell'],
        });

        // Wait for shell to exit
        const status = await wait(shellPid);

        // Send goodbye
        await write(0, new TextEncoder().encode('\r\nGoodbye!\r\n'));

        await exit(status.code);
    } catch (err) {
        // Connection likely closed
        await exit(1);
    }
}

/**
 * Send telnet negotiation sequences.
 *
 * Tells the client:
 * - We will echo (server-side echo)
 * - We will suppress go-ahead
 * - Please send window size
 */
async function sendTelnetNegotiation(): Promise<void> {
    const negotiation = new Uint8Array([
        TELNET.IAC, TELNET.WILL, TELNET.ECHO,   // Server will echo
        TELNET.IAC, TELNET.WILL, TELNET.SGA,    // Server will suppress go-ahead
        TELNET.IAC, TELNET.DO, TELNET.NAWS,     // Request client window size
    ]);

    try {
        await write(0, negotiation);
    } catch {
        // Ignore if client doesn't support
    }
}

// Run
main().catch(async (err) => {
    try {
        const msg = err instanceof Error ? err.message : String(err);
        await write(2, new TextEncoder().encode(`telnetd: ${msg}\r\n`));
    } catch {
        // Ignore write errors
    }
    await exit(1);
});
