/**
 * file - determine file type
 *
 * Usage:
 *   file [options] <file...>
 *
 * Options:
 *   -b              Brief mode (no filename prefix)
 *   -i              Output MIME type
 *   -L              Follow symlinks
 *
 * Examples:
 *   file /api/data/users/123
 *   file -i config.json
 *   file -b *
 */

import { FSError } from '@src/lib/fs/index.js';
import type { FSEntry } from '@src/lib/fs/index.js';
import { resolvePath } from '../parser.js';
import type { CommandHandler } from './shared.js';
import { parseArgs } from './shared.js';

const argSpecs = {
    brief: { short: 'b', desc: 'No filename' },
    mime: { short: 'i', desc: 'MIME type' },
    followLinks: { short: 'L', desc: 'Follow symlinks' },
};

/**
 * Detect file type from content/name
 */
function detectType(entry: FSEntry, content?: Buffer): { type: string; mime: string } {
    if (entry.type === 'directory') {
        return { type: 'directory', mime: 'inode/directory' };
    }

    if (entry.type === 'symlink') {
        return { type: `symbolic link to ${entry.target || 'unknown'}`, mime: 'inode/symlink' };
    }

    const name = entry.name.toLowerCase();

    // By extension
    if (name.endsWith('.json')) {
        return { type: 'JSON data', mime: 'application/json' };
    }
    if (name.endsWith('.xml')) {
        return { type: 'XML document', mime: 'application/xml' };
    }
    if (name.endsWith('.html') || name.endsWith('.htm')) {
        return { type: 'HTML document', mime: 'text/html' };
    }
    if (name.endsWith('.css')) {
        return { type: 'CSS stylesheet', mime: 'text/css' };
    }
    if (name.endsWith('.js')) {
        return { type: 'JavaScript source', mime: 'application/javascript' };
    }
    if (name.endsWith('.ts')) {
        return { type: 'TypeScript source', mime: 'application/typescript' };
    }
    if (name.endsWith('.md')) {
        return { type: 'Markdown document', mime: 'text/markdown' };
    }
    if (name.endsWith('.txt')) {
        return { type: 'ASCII text', mime: 'text/plain' };
    }
    if (name.endsWith('.csv')) {
        return { type: 'CSV data', mime: 'text/csv' };
    }
    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
        return { type: 'YAML document', mime: 'application/x-yaml' };
    }
    if (name.endsWith('.toml')) {
        return { type: 'TOML document', mime: 'application/toml' };
    }
    if (name.endsWith('.sh')) {
        return { type: 'Bourne-Again shell script', mime: 'application/x-sh' };
    }
    if (name.endsWith('.sql')) {
        return { type: 'SQL script', mime: 'application/sql' };
    }
    if (name.endsWith('.png')) {
        return { type: 'PNG image data', mime: 'image/png' };
    }
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        return { type: 'JPEG image data', mime: 'image/jpeg' };
    }
    if (name.endsWith('.gif')) {
        return { type: 'GIF image data', mime: 'image/gif' };
    }
    if (name.endsWith('.svg')) {
        return { type: 'SVG image', mime: 'image/svg+xml' };
    }
    if (name.endsWith('.pdf')) {
        return { type: 'PDF document', mime: 'application/pdf' };
    }
    if (name.endsWith('.zip')) {
        return { type: 'Zip archive data', mime: 'application/zip' };
    }
    if (name.endsWith('.gz') || name.endsWith('.gzip')) {
        return { type: 'gzip compressed data', mime: 'application/gzip' };
    }
    if (name.endsWith('.tar')) {
        return { type: 'POSIX tar archive', mime: 'application/x-tar' };
    }
    if (name.endsWith('.db') || name.endsWith('.sqlite')) {
        return { type: 'SQLite 3.x database', mime: 'application/x-sqlite3' };
    }

    // Check content if available
    if (content && content.length > 0) {
        const str = content.toString('utf8', 0, Math.min(content.length, 256));

        // JSON
        if (str.trimStart().startsWith('{') || str.trimStart().startsWith('[')) {
            try {
                JSON.parse(content.toString());
                return { type: 'JSON data', mime: 'application/json' };
            } catch {
                // Not valid JSON
            }
        }

        // XML
        if (str.trimStart().startsWith('<?xml') || str.trimStart().startsWith('<')) {
            return { type: 'XML document', mime: 'application/xml' };
        }

        // Shell script
        if (str.startsWith('#!')) {
            if (str.includes('/bin/sh') || str.includes('/bin/bash')) {
                return { type: 'Bourne-Again shell script', mime: 'application/x-sh' };
            }
            if (str.includes('node') || str.includes('deno') || str.includes('bun')) {
                return { type: 'JavaScript source', mime: 'application/javascript' };
            }
            if (str.includes('python')) {
                return { type: 'Python script', mime: 'text/x-python' };
            }
            return { type: 'script text executable', mime: 'text/x-script' };
        }

        // Check if it's text
        const isText = !content.some(byte => byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13));
        if (isText) {
            return { type: 'ASCII text', mime: 'text/plain' };
        }

        return { type: 'data', mime: 'application/octet-stream' };
    }

    // Empty file
    if (entry.size === 0) {
        return { type: 'empty', mime: 'inode/x-empty' };
    }

    return { type: 'data', mime: 'application/octet-stream' };
}

export const file: CommandHandler = async (session, fs, args, io) => {
    const parsed = parseArgs(args, argSpecs);

    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) {
            io.stderr.write(`file: ${err}\n`);
        }
        return 1;
    }

    if (parsed.positional.length === 0) {
        io.stderr.write('file: missing operand\n');
        io.stderr.write('Usage: file [options] <file...>\n');
        return 1;
    }

    const brief = Boolean(parsed.flags.brief);
    const mime = Boolean(parsed.flags.mime);
    const followLinks = Boolean(parsed.flags.followLinks);

    let exitCode = 0;

    for (const file of parsed.positional) {
        const resolved = resolvePath(session.cwd, file);

        try {
            let entry = await fs!.stat(resolved);

            // Follow symlinks if requested
            if (followLinks && entry.type === 'symlink' && entry.target) {
                try {
                    entry = await fs!.stat(entry.target);
                } catch {
                    // Keep symlink entry if target not found
                }
            }

            // Try to read content for better detection
            let content: Buffer | undefined;
            if (entry.type === 'file' && entry.size > 0 && entry.size < 65536) {
                try {
                    const data = await fs!.read(resolved);
                    content = Buffer.isBuffer(data) ? data : Buffer.from(data);
                } catch {
                    // Ignore read errors
                }
            }

            const { type, mime: mimeType } = detectType(entry, content);
            const output = mime ? mimeType : type;

            if (brief) {
                io.stdout.write(`${output}\n`);
            } else {
                io.stdout.write(`${file}: ${output}\n`);
            }
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`file: ${file}: ${err.message}\n`);
                exitCode = 1;
            } else {
                throw err;
            }
        }
    }

    return exitCode;
};
