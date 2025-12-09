/**
 * expire - Permanently delete an EMS record (hard delete)
 *
 * Usage:
 *   expire <model> <id>
 *
 * Output: The expired record as JSON
 *
 * Examples:
 *   expire ai.request abc123
 *   expire ai.stm xyz789
 *
 * WARNING: This permanently removes the record. It cannot be recovered.
 * Use 'delete' for soft delete (recoverable with 'revert').
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
        await println('Usage: expire <model> <id>');
        await println('');
        await println('Examples:');
        await println('  expire ai.request abc123');
        await println('  expire ai.stm xyz789');
        await println('');
        await println('WARNING: This permanently removes the record. Use "delete" for soft delete.');
        await exit(0);
        return;
    }

    const model = args[1];
    const id = args[2];

    try {
        const expired = await call<Record<string, unknown>>('ems:expire', model, id);
        await println(JSON.stringify(expired, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`expire: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`expire: ${err.message}`);
    await exit(1);
});
