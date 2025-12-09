/**
 * revert - Restore a soft-deleted EMS record
 *
 * Usage:
 *   revert <model> <id>
 *
 * Output: The restored record as JSON
 *
 * Examples:
 *   revert ai.request abc123
 *   revert ai.stm xyz789
 *
 * Note: This restores a record that was soft-deleted with 'delete'.
 */

import {
    getargs,
    println,
    eprintln,
    exit,
    call,
} from '@rom/lib/process/index.js';

async function main(): Promise<void> {
    const args = await getargs();

    if (args.length < 3) {
        await println('Usage: revert <model> <id>');
        await println('');
        await println('Examples:');
        await println('  revert ai.request abc123');
        await println('  revert ai.stm xyz789');
        await println('');
        await println('Note: This restores a record that was soft-deleted with "delete".');
        await exit(0);
        return;
    }

    const model = args[1];
    const id = args[2];

    try {
        const reverted = await call<Record<string, unknown>>('ems:revert', model, id);
        await println(JSON.stringify(reverted, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`revert: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`revert: ${err.message}`);
    await exit(1);
});
