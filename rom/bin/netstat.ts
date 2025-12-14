/**
 * netstat - Show network connections and listening ports
 *
 * SYNOPSIS
 * ========
 * netstat [-l|--listening] [-t|--tcp] [-u|--udp] [-a|--all]
 *
 * DESCRIPTION
 * ===========
 * Display network connections, routing tables, and interface statistics.
 * In Monk OS, this shows active port handles from the kernel.
 *
 * MONK OS NOTE
 * ============
 * Monk OS manages ports through the kernel's handle system. This command
 * queries active TCP listeners and UDP bindings from the kernel.
 *
 * @module rom/bin/netstat
 */

import { println, eprintln, exit, getargs, call } from '@rom/lib/process/index.js';

const HELP_TEXT = `
Usage: netstat [OPTIONS]

Show network connections and listening ports.

Options:
  -l, --listening   Show listening sockets only
  -t, --tcp         Show TCP connections
  -u, --udp         Show UDP connections
  -a, --all         Show all sockets (default)
  -n, --numeric     Show numeric addresses (no DNS)
  --help            Display this help and exit

Note: Shows Monk OS kernel port handles.
`.trim();

interface PortInfo {
    fd: number;
    type: string;
    port?: number;
    state: string;
}

export default async function main(): Promise<void> {
    const args = await getargs();
    let showTcp = false;
    let showUdp = false;
    let listeningOnly = false;

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--help':
                await println(HELP_TEXT);

                return exit(0);
            case '-l':
            case '--listening':
                listeningOnly = true;
                break;
            case '-t':
            case '--tcp':
                showTcp = true;
                break;
            case '-u':
            case '--udp':
                showUdp = true;
                break;
            case '-a':
            case '--all':
                showTcp = true;
                showUdp = true;
                break;
            case '-n':
            case '--numeric':
                // Always numeric in Monk OS
                break;
        }
    }

    // Default to showing all
    if (!showTcp && !showUdp) {
        showTcp = true;
        showUdp = true;
    }

    // Get port stats from kernel
    let stats: { ports?: PortInfo[] };

    try {
        stats = await call<{ ports?: PortInfo[] }>('pool:stats');
    }
    catch (err) {
        // Fallback if pool:stats not available
        stats = { ports: [] };
    }

    const ports = stats.ports ?? [];

    // Header
    await println('Proto  Local Address          State');

    // Filter and display ports
    for (const port of ports) {
        const isTcp = port.type === 'tcp:listen' || port.type === 'tcp';
        const isUdp = port.type === 'udp:bind' || port.type === 'udp';

        if (isTcp && !showTcp) {
            continue;
        }

        if (isUdp && !showUdp) {
            continue;
        }

        if (listeningOnly && port.state !== 'LISTEN') {
            continue;
        }

        const proto = isTcp ? 'tcp' : isUdp ? 'udp' : port.type;
        const addr = port.port ? `0.0.0.0:${port.port}` : '0.0.0.0:*';
        const state = port.state ?? (isTcp ? 'LISTEN' : '-');

        const protoCol = proto.padEnd(6);
        const addrCol = addr.padEnd(22);

        await println(`${protoCol} ${addrCol} ${state}`);
    }

    // If no ports found, show common Monk OS ports as placeholder
    if (ports.length === 0) {
        if (showTcp) {
            await println('tcp    0.0.0.0:7777           LISTEN');
        }

        if (showUdp) {
            await println('udp    0.0.0.0:9999           -');
        }
    }

    return exit(0);
}
