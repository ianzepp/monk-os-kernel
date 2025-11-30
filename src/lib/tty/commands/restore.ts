/**
 * restore - Import tenant data from SQLite file
 *
 * Usage:
 *   restore <path> [models...]
 *
 * Options:
 *   -s, --schema     Schema only (no data)
 *   -d, --data       Data only (no schema)
 *   --replace        Delete existing data before import
 *   --skip           Skip existing records (don't update)
 *   --merge          Only import newly-created models
 *
 * Default strategy is 'upsert' (update existing, insert new).
 *
 * Examples:
 *   restore /tmp/backup.db                  Import all
 *   restore /tmp/backup.db users            Import specific models
 *   restore --replace /tmp/backup.db        Replace all data
 *   restore -s /tmp/schema.db               Schema only
 */

import { FSError } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import type { System } from '@src/lib/system.js';
import type { ImportStrategy } from '@src/lib/database/import.js';

export const restore: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('restore: filesystem not available\n');
        return 1;
    }

    // Parse options
    let schemaOnly = false;
    let dataOnly = false;
    let strategy: ImportStrategy = 'upsert';
    const positional: string[] = [];

    for (const arg of args) {
        if (arg === '-s' || arg === '--schema') {
            schemaOnly = true;
        } else if (arg === '-d' || arg === '--data') {
            dataOnly = true;
        } else if (arg === '--replace') {
            strategy = 'replace';
        } else if (arg === '--skip') {
            strategy = 'skip';
        } else if (arg === '--merge') {
            strategy = 'merge';
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    if (positional.length === 0) {
        io.stderr.write('restore: missing input path\n');
        io.stderr.write('Usage: restore <path> [models...]\n');
        return 1;
    }

    const inputPath = resolvePath(session.cwd, positional[0]);
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
        // Read SQLite file
        const content = await fs.read(inputPath);
        const buffer = content instanceof Buffer ? new Uint8Array(content) : new Uint8Array(Buffer.from(content));

        // Access the system from fs to get database
        const system = fs.system as System;

        const result = await system.database.importAll(buffer, {
            strategy,
            models: models.length > 0 ? models : undefined,
            include,
        });

        // Output summary
        io.stdout.write(`Restored from ${positional[0]}\n`);
        io.stdout.write(`Strategy: ${strategy}\n`);
        io.stdout.write(`Source: exported ${result.meta.exported_at}\n`);
        io.stdout.write(`Models: ${result.meta.models.join(', ') || '(none)'}\n`);
        io.stdout.write('\n');
        io.stdout.write('Statistics:\n');
        io.stdout.write(`  Models created: ${result.stats.models_created}\n`);
        io.stdout.write(`  Models updated: ${result.stats.models_updated}\n`);
        io.stdout.write(`  Fields created: ${result.stats.fields_created}\n`);
        io.stdout.write(`  Fields updated: ${result.stats.fields_updated}\n`);
        io.stdout.write(`  Records created: ${result.stats.records_created}\n`);
        io.stdout.write(`  Records updated: ${result.stats.records_updated}\n`);
        io.stdout.write(`  Records skipped: ${result.stats.records_skipped}\n`);

        return 0;
    } catch (err) {
        if (err instanceof FSError) {
            io.stderr.write(`restore: ${positional[0]}: ${err.message}\n`);
            return 1;
        }
        if (err instanceof Error) {
            io.stderr.write(`restore: ${err.message}\n`);
            return 1;
        }
        throw err;
    }
};
