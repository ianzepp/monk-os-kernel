/**
 * dump - Export tenant data to SQLite file
 *
 * Usage:
 *   dump <path> [models...]
 *
 * Options:
 *   -s, --schema    Schema only (no data)
 *   -d, --data      Data only (no schema)
 *   --strip-access  Remove access control fields
 *
 * Examples:
 *   dump /tmp/backup.db                  Export all models
 *   dump /tmp/backup.db users orders     Export specific models
 *   dump -s /tmp/schema.db               Schema only
 *   dump --strip-access /tmp/fixture.db  For test fixtures
 *
 * Output is an SQLite database file.
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import type { System } from '@src/lib/system.js';

export const dump: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('dump: filesystem not available\n');
        return 1;
    }

    // Parse options
    let schemaOnly = false;
    let dataOnly = false;
    let stripAccess = false;
    const positional: string[] = [];

    for (const arg of args) {
        if (arg === '-s' || arg === '--schema') {
            schemaOnly = true;
        } else if (arg === '-d' || arg === '--data') {
            dataOnly = true;
        } else if (arg === '--strip-access') {
            stripAccess = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length === 0) {
        io.stderr.write('dump: missing output path\n');
        io.stderr.write('Usage: dump <path> [models...]\n');
        return 1;
    }

    const outputPath = resolvePath(session.cwd, positional[0]);
    const models = positional.slice(1);

    // Determine what to include
    const include: ('describe' | 'data')[] = [];
    if (schemaOnly) {
        include.push('describe');
    } else if (dataOnly) {
        include.push('data');
    } else {
        include.push('describe', 'data');
    }

    try {
        // Access the system from fs to get database
        const system = fs.system as System;

        const result = await system.database.exportAll({
            models: models.length > 0 ? models : undefined,
            include,
            stripAccess,
        });

        // Write SQLite buffer to file
        await fs.write(outputPath, Buffer.from(result.buffer));

        // Output summary
        io.stdout.write(`Exported to ${positional[0]}\n`);
        io.stdout.write(`Models: ${result.meta.models.join(', ') || '(none)'}\n`);
        io.stdout.write(`Include: ${result.meta.include.join(', ')}\n`);

        const totalRecords = Object.values(result.meta.record_counts).reduce((a, b) => a + b, 0);
        if (result.meta.include.includes('data')) {
            io.stdout.write(`Records: ${totalRecords}\n`);
            for (const [model, count] of Object.entries(result.meta.record_counts)) {
                io.stdout.write(`  ${model}: ${count}\n`);
            }
        }

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`dump: ${positional[0]}: ${err.message}\n`);
            return 1;
        }
        if (err instanceof Error) {
            io.stderr.write(`dump: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};
