/**
 * uname - Print system information
 *
 * Usage:
 *   uname              Print kernel name (default: -s)
 *   uname -a           Print all information
 *   uname -s           Print kernel name
 *   uname -n           Print network node hostname
 *   uname -r           Print kernel release
 *   uname -v           Print kernel version
 *   uname -m           Print machine hardware name
 *   uname -o           Print operating system
 *
 * Examples:
 *   uname -a
 *   uname -sr
 */

import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const KERNEL_NAME = 'Monk';
const KERNEL_RELEASE = '1.0.0';
const KERNEL_VERSION = '#1 SMP ' + new Date().toDateString();
const MACHINE = 'virtual';
const OS = 'MonkOS';

export const uname: CommandHandler = async (session, _fs, args, io) => {
    const { flags } = parseArgs(args, {
        all: { short: 'a', long: 'all' },
        kernel: { short: 's', long: 'kernel-name' },
        nodename: { short: 'n', long: 'nodename' },
        release: { short: 'r', long: 'kernel-release' },
        version: { short: 'v', long: 'kernel-version' },
        machine: { short: 'm', long: 'machine' },
        os: { short: 'o', long: 'operating-system' },
    });

    const hostname = session.tenant || 'localhost';

    // If -a, print everything
    if (flags.all) {
        io.stdout.write(`${KERNEL_NAME} ${hostname} ${KERNEL_RELEASE} ${KERNEL_VERSION} ${MACHINE} ${OS}\n`);
        return 0;
    }

    // If no flags, default to -s
    const hasFlags = flags.kernel || flags.nodename || flags.release ||
                     flags.version || flags.machine || flags.os;

    const parts: string[] = [];

    if (flags.kernel || !hasFlags) parts.push(KERNEL_NAME);
    if (flags.nodename) parts.push(hostname);
    if (flags.release) parts.push(KERNEL_RELEASE);
    if (flags.version) parts.push(KERNEL_VERSION);
    if (flags.machine) parts.push(MACHINE);
    if (flags.os) parts.push(OS);

    io.stdout.write(parts.join(' ') + '\n');
    return 0;
};
