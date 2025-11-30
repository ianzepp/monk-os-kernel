/**
 * Format Encoder/Decoder Registry
 *
 * Centralized registry for all data serialization formatters.
 *
 * Core Formatters (always available):
 * - json, yaml
 *
 * Optional Formatters (loaded from @monk/formatter-* packages if installed):
 * - toon, toml, csv, sqlite, msgpack, cbor, qr, brainfuck, morse, markdown, grid-compact
 *
 * Usage:
 *   import { getFormatter } from '@src/lib/formatters/index.js';
 *   const formatter = getFormatter('yaml');
 *   if (formatter) {
 *       const encoded = formatter.encode(data);
 *   }
 */

// Re-export Formatter interface from common package
import { type Formatter } from '@monk/common';
export { type Formatter };

/**
 * Registry: format name -> Formatter instance
 */
export const formatters = new Map<string, Formatter>();

// Core formatters (always available, no external deps)
import { JsonFormatter } from './json.js';
import { YamlFormatter } from './yaml.js';

formatters.set('json', JsonFormatter);
formatters.set('yaml', YamlFormatter);

// Re-export core formatters for direct access
export { JsonFormatter, YamlFormatter };

/**
 * Optional formatters - loaded dynamically from @monk/formatter-* packages
 * Convention: @monk/formatter-<format> exports <PascalCaseFormat>Formatter
 */
const optionalFormats = [
    'toon',
    'toml',
    'csv',
    'sqlite',
    'msgpack',
    'cbor',
    'qr',
    'brainfuck',
    'morse',
    'markdown',
    'grid-compact'
];

/**
 * Convert format name to PascalCase formatter export name
 * e.g., 'grid-compact' -> 'GridCompactFormatter'
 */
function toFormatterName(format: string): string {
    return format
        .split('-')
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join('') + 'Formatter';
}

// Load optional formatters at module initialization
for (const format of optionalFormats) {
    try {
        const mod = await import(`@monk/formatter-${format}`);
        const formatterName = toFormatterName(format);
        if (mod[formatterName]) {
            formatters.set(format, mod[formatterName]);
        }
    } catch {
        // Package not installed - formatter unavailable
    }
}

/**
 * Get a formatter by name
 * Returns null if the format is not available
 */
export function getFormatter(format: string): Formatter | null {
    return formatters.get(format) ?? null;
}

/**
 * Check if a format is available
 */
export function hasFormatter(format: string): boolean {
    return formatters.has(format);
}

/**
 * Get list of all available format names
 */
export function getAvailableFormats(): string[] {
    return Array.from(formatters.keys());
}
