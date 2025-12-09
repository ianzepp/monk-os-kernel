/**
 * delete - Delete an EMS record (soft delete)
 *
 * Usage:
 *   delete <model> <id>
 *
 * Output: The deleted record as JSON
 *
 * Examples:
 *   delete ai.request abc123
 *   delete ai.stm xyz789
 *
 * Note: This performs a soft delete (sets deleted_at timestamp).
 * Use 'expire' for permanent deletion.
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
        await println('Usage: delete <model> <id>');
        await println('');
        await println('Examples:');
        await println('  delete ai.request abc123');
        await println('  delete ai.stm xyz789');
        await println('');
        await println('Note: This performs a soft delete. Use "expire" for permanent deletion.');
        await exit(0);
        return;
    }

    const model = args[1];
    const id = args[2];

    try {
        const deleted = await call<Record<string, unknown>>('ems:delete', model, id);
        await println(JSON.stringify(deleted, null, 2));
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`delete: ${msg}`);
        await exit(1);
    }
}

main().catch(async err => {
    await eprintln(`delete: ${err.message}`);
    await exit(1);
});
