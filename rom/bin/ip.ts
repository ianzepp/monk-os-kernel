/**
 * ip - Show network interface information
 *
 * SYNOPSIS
 * ========
 * ip [addr|link|route]
 *
 * DESCRIPTION
 * ===========
 * Display network configuration information. In Monk OS, networking is
 * delegated to the host system via Bun's fetch API, so this command
 * shows placeholder/simulated information.
 *
 * MONK OS NOTE
 * ============
 * Monk OS does not have direct network interface access. All network
 * operations go through the HAL (Hardware Abstraction Layer) which
 * delegates to the host. This command exists for compatibility and
 * returns simulated localhost information.
 *
 * @module rom/bin/ip
 */

import { println, exit, getargs } from '@rom/lib/process/index.js';

const HELP_TEXT = `
Usage: ip [OBJECT]

Show network information (simulated - Monk OS uses host networking).

Objects:
  addr, a     Show addresses
  link, l     Show link status
  route, r    Show routing table

Options:
  --help      Display this help and exit

Note: Monk OS delegates networking to the host system.
`.trim();

const ADDR_OUTPUT = `
1: lo: <LOOPBACK,UP> mtu 65536
    inet 127.0.0.1/8 scope host lo
    inet6 ::1/128 scope host
2: eth0: <UP> mtu 1500
    inet 10.0.0.1/24 scope global eth0
    inet6 fe80::1/64 scope link
`.trim();

const LINK_OUTPUT = `
1: lo: <LOOPBACK,UP> mtu 65536 state UP
    link/loopback 00:00:00:00:00:00
2: eth0: <UP> mtu 1500 state UP
    link/ether 02:00:00:00:00:01
`.trim();

const ROUTE_OUTPUT = `
default via 10.0.0.254 dev eth0
10.0.0.0/24 dev eth0 proto kernel scope link src 10.0.0.1
127.0.0.0/8 dev lo proto kernel scope link src 127.0.0.1
`.trim();

export default async function main(): Promise<void> {
    const args = await getargs();
    const cmd = args[1] ?? 'addr';

    if (cmd === '--help' || cmd === '-h') {
        await println(HELP_TEXT);
        return exit(0);
    }

    switch (cmd) {
        case 'addr':
        case 'a':
        case 'address':
            await println(ADDR_OUTPUT);
            break;

        case 'link':
        case 'l':
            await println(LINK_OUTPUT);
            break;

        case 'route':
        case 'r':
            await println(ROUTE_OUTPUT);
            break;

        default:
            await println(`ip: unknown object "${cmd}"`);
            return exit(1);
    }

    return exit(0);
}
