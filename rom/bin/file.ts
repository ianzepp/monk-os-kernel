/**
 * file - determine file type
 *
 * Usage: file [options] <file...>
 *
 * Options:
 *   -b              Brief mode (no filename prefix)
 *   -i              Output MIME type
 *
 * Examples:
 *   file config.json
 *   file -i *.ts
 *   file -b *
 */

import {
    getargs,
    getcwd,
    stat,
    open,
    head,
    close,
    println,
    eprintln,
    exit,
} from '@rom/lib/process';
import { resolvePath } from '@rom/lib/shell';
import type { Stat } from '@rom/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0) {
        await eprintln('file: missing operand');
        await eprintln('Usage: file [options] <file...>');
        await exit(1);
    }

    if (argv[0] === '-h' || argv[0] === '--help') {
        await println('Usage: file [options] <file...>');
        await println('Options: -b (brief), -i (mime type)');
        await exit(0);
    }

    // Parse options
    let brief = false;
    let mime = false;
    const files: string[] = [];

    for (const arg of argv) {
        if (arg === '-b') {
            brief = true;
        }
        else if (arg === '-i') {
            mime = true;
        }
        else if (!arg.startsWith('-')) {
            files.push(arg);
        }
    }

    if (files.length === 0) {
        await eprintln('file: missing operand');
        await exit(1);
    }

    const cwd = await getcwd();
    let exitCode = 0;

    for (const file of files) {
        const resolved = resolvePath(cwd, file);

        try {
            const entry = await stat(resolved);
            let content: Uint8Array | undefined;

            // Read content for better detection
            if (entry.model === 'file' && entry.size > 0 && entry.size < 65536) {
                try {
                    const fd = await open(resolved, { read: true });

                    content = await head(fd, Math.min(entry.size, 512));
                    await close(fd);
                }
                catch {
                    // Ignore read errors
                }
            }

            const { type, mimeType } = detectType(entry, content);
            const output = mime ? mimeType : type;

            if (brief) {
                await println(output);
            }
            else {
                await println(`${file}: ${output}`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            await eprintln(`file: ${file}: ${msg}`);
            exitCode = 1;
        }
    }

    await exit(exitCode);
}

function detectType(entry: Stat, content?: Uint8Array): { type: string; mimeType: string } {
    if (entry.model === 'folder') {
        return { type: 'directory', mimeType: 'inode/directory' };
    }

    if (entry.model === 'device') {
        return { type: 'device', mimeType: 'inode/chardevice' };
    }

    if (entry.model === 'proc') {
        return { type: 'process info', mimeType: 'inode/x-proc' };
    }

    const name = entry.name.toLowerCase();

    // By extension
    if (name.endsWith('.json')) {
        return { type: 'JSON data', mimeType: 'application/json' };
    }

    if (name.endsWith('.xml')) {
        return { type: 'XML document', mimeType: 'application/xml' };
    }

    if (name.endsWith('.html') || name.endsWith('.htm')) {
        return { type: 'HTML document', mimeType: 'text/html' };
    }

    if (name.endsWith('.css')) {
        return { type: 'CSS stylesheet', mimeType: 'text/css' };
    }

    if (name.endsWith('.js')) {
        return { type: 'JavaScript source', mimeType: 'application/javascript' };
    }

    if (name.endsWith('.ts')) {
        return { type: 'TypeScript source', mimeType: 'application/typescript' };
    }

    if (name.endsWith('.md')) {
        return { type: 'Markdown document', mimeType: 'text/markdown' };
    }

    if (name.endsWith('.txt')) {
        return { type: 'ASCII text', mimeType: 'text/plain' };
    }

    if (name.endsWith('.csv')) {
        return { type: 'CSV data', mimeType: 'text/csv' };
    }

    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
        return { type: 'YAML document', mimeType: 'application/x-yaml' };
    }

    if (name.endsWith('.sh')) {
        return { type: 'shell script', mimeType: 'application/x-sh' };
    }

    if (name.endsWith('.sql')) {
        return { type: 'SQL script', mimeType: 'application/sql' };
    }

    if (name.endsWith('.png')) {
        return { type: 'PNG image', mimeType: 'image/png' };
    }

    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
        return { type: 'JPEG image', mimeType: 'image/jpeg' };
    }

    if (name.endsWith('.gif')) {
        return { type: 'GIF image', mimeType: 'image/gif' };
    }

    if (name.endsWith('.svg')) {
        return { type: 'SVG image', mimeType: 'image/svg+xml' };
    }

    if (name.endsWith('.pdf')) {
        return { type: 'PDF document', mimeType: 'application/pdf' };
    }

    if (name.endsWith('.zip')) {
        return { type: 'Zip archive', mimeType: 'application/zip' };
    }

    // Check content
    if (content && content.length > 0) {
        const str = new TextDecoder().decode(content.slice(0, 256));

        if (str.trimStart().startsWith('{') || str.trimStart().startsWith('[')) {
            return { type: 'JSON data', mimeType: 'application/json' };
        }

        if (str.trimStart().startsWith('<?xml') || str.trimStart().startsWith('<')) {
            return { type: 'XML document', mimeType: 'application/xml' };
        }

        if (str.startsWith('#!')) {
            return { type: 'script text executable', mimeType: 'text/x-script' };
        }

        // Check if text
        const isText = !Array.from(content).some(b => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13));

        if (isText) {
            return { type: 'ASCII text', mimeType: 'text/plain' };
        }

        return { type: 'data', mimeType: 'application/octet-stream' };
    }

    if (entry.size === 0) {
        return { type: 'empty', mimeType: 'inode/x-empty' };
    }

    return { type: 'data', mimeType: 'application/octet-stream' };
}

main().catch(async err => {
    await eprintln(`file: ${err.message}`);
    await exit(1);
});
