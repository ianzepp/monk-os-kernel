/**
 * uname - print system information
 *
 * Usage: uname [OPTIONS]
 *
 * Options:
 *   -a   Print all information
 *   -s   Print kernel name (default)
 *   -n   Print network node hostname
 *   -r   Print kernel release
 *   -v   Print kernel version
 *   -m   Print machine hardware name
 *   -o   Print operating system
 *
 * Examples:
 *   uname
 *   uname -a
 *   uname -sr
 */

import { getargs, getenv, println, exit } from '@os/process';
import { parseArgs } from '@os/shell';

const KERNEL_NAME = 'Monk';
const KERNEL_RELEASE = '1.0.0';
const KERNEL_VERSION = '#1 SMP ' + new Date().toDateString();
const MACHINE = 'virtual';
const OS = 'MonkOS';

const argSpecs = {
    all: { short: 'a', long: 'all' },
    kernel: { short: 's', long: 'kernel-name' },
    nodename: { short: 'n', long: 'nodename' },
    release: { short: 'r', long: 'kernel-release' },
    version: { short: 'v', long: 'kernel-version' },
    machine: { short: 'm', long: 'machine' },
    os: { short: 'o', long: 'operating-system' },
};

async function main(): Promise<void> {
    const args = await getargs();
    const { flags } = parseArgs(args.slice(1), argSpecs);

    // Try to get hostname from environment
    const hostname = await getenv('HOSTNAME') || 'localhost';

    // If -a, print everything
    if (flags.all) {
        await println(`${KERNEL_NAME} ${hostname} ${KERNEL_RELEASE} ${KERNEL_VERSION} ${MACHINE} ${OS}`);
        await exit(0);
    }

    // If no flags, default to -s
    const hasFlags = flags.kernel || flags.nodename || flags.release ||
                     flags.version || flags.machine || flags.os;

    const parts: string[] = [];

    if (flags.kernel || !hasFlags) {
        parts.push(KERNEL_NAME);
    }

    if (flags.nodename) {
        parts.push(hostname);
    }

    if (flags.release) {
        parts.push(KERNEL_RELEASE);
    }

    if (flags.version) {
        parts.push(KERNEL_VERSION);
    }

    if (flags.machine) {
        parts.push(MACHINE);
    }

    if (flags.os) {
        parts.push(OS);
    }

    await println(parts.join(' '));
    await exit(0);
}

main().catch(async () => {
    await exit(1);
});
