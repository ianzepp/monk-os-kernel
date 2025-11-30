/**
 * Environment Variable Loader
 *
 * Simple .env file parser that replaces the dotenv package.
 * Loads KEY=VALUE pairs from .env files into process.env.
 *
 * Features:
 * - Supports comments (#)
 * - Supports empty lines
 * - Supports quoted values (single and double)
 * - Supports inline comments after values
 * - Does not override existing environment variables
 */

import { readFileSync, existsSync } from 'fs';

export interface LoadEnvOptions {
    /** Path to .env file (default: '.env') */
    path?: string;
    /** Print debug info (default: false) */
    debug?: boolean;
    /** Override existing env vars (default: false) */
    override?: boolean;
}

/**
 * Parse a single line from .env file
 * Returns [key, value] tuple or null if line should be skipped
 */
function parseLine(line: string): [string, string] | null {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }

    // Find the first = sign
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
        return null;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Skip if no key
    if (!key) {
        return null;
    }

    // Handle quoted values
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        // Remove quotes
        value = value.slice(1, -1);
    } else {
        // Remove inline comments (only for unquoted values)
        const hashIndex = value.indexOf('#');
        if (hashIndex !== -1) {
            value = value.slice(0, hashIndex).trim();
        }
    }

    return [key, value];
}

/**
 * Load environment variables from a .env file
 */
export function loadEnv(options: LoadEnvOptions = {}): void {
    const {
        path = '.env',
        debug = false,
        override = false
    } = options;

    // Check if file exists
    if (!existsSync(path)) {
        if (debug) {
            console.debug(`[env] File not found: ${path}`);
        }
        return;
    }

    // Read and parse file
    const content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');
    let loaded = 0;
    let skipped = 0;

    for (const line of lines) {
        const parsed = parseLine(line);
        if (!parsed) continue;

        const [key, value] = parsed;

        // Check if already set
        if (process.env[key] !== undefined && !override) {
            skipped++;
            if (debug) {
                console.debug(`[env] Skipping ${key} (already set)`);
            }
            continue;
        }

        process.env[key] = value;
        loaded++;

        if (debug) {
            // Mask sensitive values
            const masked = key.toLowerCase().includes('secret') ||
                          key.toLowerCase().includes('password') ||
                          key.toLowerCase().includes('key')
                ? '***'
                : value;
            console.debug(`[env] Set ${key}=${masked}`);
        }
    }

    if (debug) {
        console.debug(`[env] Loaded ${loaded} variables from ${path} (${skipped} skipped)`);
    }
}

/**
 * Convenience function matching dotenv.config() signature
 */
export function config(options: LoadEnvOptions = {}): void {
    loadEnv(options);
}
