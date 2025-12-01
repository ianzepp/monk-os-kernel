/**
 * chmod - change file mode bits (NOT SUPPORTED)
 *
 * Usage: chmod mode file...
 *
 * Monk OS uses grant-based ACLs, not UNIX permission bits.
 * This command exists for compatibility but always returns EPERM.
 *
 * Use 'grant' for ACL management instead:
 *   grant +read user /path/to/file
 *   grant --list /path/to/file
 */

import { getargs, eprintln, exit } from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
        await eprintln('Usage: chmod mode file...');
        await eprintln('');
        await eprintln('NOTE: UNIX permission bits are not supported in Monk OS.');
        await eprintln('Monk uses grant-based ACLs. Use the "grant" command instead:');
        await eprintln('');
        await eprintln('  grant +read user /path/to/file    Add read permission');
        await eprintln('  grant -write user /path/to/file   Remove write permission');
        await eprintln('  grant --list /path/to/file        Show current ACL');
        await eprintln('  grant --help                      Full usage');
        await exit(argv[0] === '-h' || argv[0] === '--help' ? 0 : 1);
    }

    await eprintln('chmod: UNIX permission bits are not supported');
    await eprintln('chmod: Use "grant" for ACL management');
    await exit(1);
}

main().catch(async (err) => {
    await eprintln(`chmod: ${err.message}`);
    await exit(1);
});
