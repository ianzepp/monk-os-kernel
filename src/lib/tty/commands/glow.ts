/**
 * glow - Render markdown with ANSI terminal styling
 *
 * Usage:
 *   glow <file>           Render markdown file
 *   <input> | glow        Render piped markdown
 *
 * Examples:
 *   glow README.md
 *   ai explain docker | glow
 *   cat notes.md | glow
 */

import type { CommandHandler } from './shared.js';
import { resolvePath } from '../parser.js';
import { FSError } from '@src/lib/fs/index.js';

// ANSI escape codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const BOLD_OFF = '\x1b[22m';
const ITALIC_OFF = '\x1b[23m';
const UNDERLINE_OFF = '\x1b[24m';

// Colors
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const COLOR_OFF = '\x1b[39m';

// Background
const BG_GRAY = '\x1b[48;5;236m';
const BG_OFF = '\x1b[49m';

export const glow: CommandHandler = async (session, fs, args, io) => {
    let input = '';

    if (args.length > 0) {
        // Read from file
        if (!fs) {
            io.stderr.write('glow: filesystem not available\n');
            return 1;
        }

        const file = args[0];
        const resolved = resolvePath(session.cwd, file);

        try {
            const data = await fs.read(resolved);
            input = data.toString();
        } catch (err) {
            if (err instanceof FSError) {
                io.stderr.write(`glow: ${file}: ${err.message}\n`);
                return 1;
            }
            throw err;
        }
    } else {
        // Read from stdin
        for await (const chunk of io.stdin) {
            if (io.signal?.aborted) return 130;
            input += chunk.toString();
        }
    }

    if (!input) {
        return 0;
    }

    const output = renderMarkdown(input);
    io.stdout.write(output);

    // Ensure trailing newline
    if (!output.endsWith('\n')) {
        io.stdout.write('\n');
    }

    return 0;
};

/**
 * Render markdown to ANSI-styled text
 */
export function renderMarkdown(text: string): string {
    const lines = text.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let codeBlockLang = '';
    let codeBlockLines: string[] = [];
    let inTable = false;
    let tableRows: string[][] = [];
    let tableAlignments: ('left' | 'center' | 'right')[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Code block start/end
        if (line.startsWith('```')) {
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeBlockLang = line.slice(3).trim();
                codeBlockLines = [];
            } else {
                // Render the code block with proper width
                const width = Math.max(40, ...codeBlockLines.map(l => l.length + 2));
                result.push(`${DIM}┌${'─'.repeat(width)}┐${RESET}`);
                if (codeBlockLang) {
                    const langPad = ' '.repeat(width - codeBlockLang.length - 1);
                    result.push(`${DIM}│${RESET} ${CYAN}${codeBlockLang}${RESET}${langPad}${DIM}│${RESET}`);
                    result.push(`${DIM}├${'─'.repeat(width)}┤${RESET}`);
                }
                for (const codeLine of codeBlockLines) {
                    const pad = ' '.repeat(width - codeLine.length - 1);
                    result.push(`${DIM}│${RESET} ${CYAN}${codeLine}${RESET}${pad}${DIM}│${RESET}`);
                }
                result.push(`${DIM}└${'─'.repeat(width)}┘${RESET}`);
                inCodeBlock = false;
                codeBlockLang = '';
                codeBlockLines = [];
            }
            continue;
        }

        // Inside code block - collect lines
        if (inCodeBlock) {
            codeBlockLines.push(line);
            continue;
        }

        // Table detection and handling
        if (line.includes('|')) {
            const cells = parseTableRow(line);
            if (cells) {
                // Check if this is a separator row (|---|---|)
                if (isTableSeparator(line)) {
                    tableAlignments = parseAlignments(line);
                    continue;
                }

                if (!inTable) {
                    inTable = true;
                    tableRows = [];
                }
                tableRows.push(cells);
                continue;
            }
        }

        // End of table - render it
        if (inTable) {
            result.push(...renderTable(tableRows, tableAlignments));
            inTable = false;
            tableRows = [];
            tableAlignments = [];
        }

        // Headings
        if (line.startsWith('# ')) {
            result.push(`${BOLD}${YELLOW}${line.slice(2)}${RESET}`);
            result.push(`${YELLOW}${'═'.repeat(Math.min(line.length - 2, 60))}${RESET}`);
            continue;
        }
        if (line.startsWith('## ')) {
            result.push(`${BOLD}${BLUE}${line.slice(3)}${RESET}`);
            result.push(`${BLUE}${'─'.repeat(Math.min(line.length - 3, 40))}${RESET}`);
            continue;
        }
        if (line.startsWith('### ')) {
            result.push(`${BOLD}${MAGENTA}${line.slice(4)}${RESET}`);
            continue;
        }
        if (line.startsWith('#### ')) {
            result.push(`${BOLD}${line.slice(5)}${RESET}`);
            continue;
        }

        // Horizontal rule
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
            result.push(`${DIM}${'─'.repeat(60)}${RESET}`);
            continue;
        }

        // Blockquote
        if (line.startsWith('> ')) {
            result.push(`${DIM}│${RESET} ${ITALIC}${line.slice(2)}${ITALIC_OFF}`);
            continue;
        }

        // Unordered list
        if (/^(\s*)[-*+] /.test(line)) {
            const match = line.match(/^(\s*)[-*+] (.*)$/);
            if (match) {
                const indent = match[1];
                const content = renderInline(match[2]);
                result.push(`${indent}${GREEN}•${RESET} ${content}`);
                continue;
            }
        }

        // Ordered list
        if (/^\s*\d+\. /.test(line)) {
            const match = line.match(/^(\s*)(\d+)\. (.*)$/);
            if (match) {
                const indent = match[1];
                const num = match[2];
                const content = renderInline(match[3]);
                result.push(`${indent}${GREEN}${num}.${RESET} ${content}`);
                continue;
            }
        }

        // Task list
        if (/^(\s*)[-*] \[([ xX])\] /.test(line)) {
            const match = line.match(/^(\s*)[-*] \[([ xX])\] (.*)$/);
            if (match) {
                const indent = match[1];
                const checked = match[2].toLowerCase() === 'x';
                const content = renderInline(match[3]);
                const checkbox = checked ? `${GREEN}✓${RESET}` : `${DIM}○${RESET}`;
                result.push(`${indent}${checkbox} ${content}`);
                continue;
            }
        }

        // Regular paragraph - apply inline formatting
        result.push(renderInline(line));
    }

    // Handle unclosed table
    if (inTable && tableRows.length > 0) {
        result.push(...renderTable(tableRows, tableAlignments));
    }

    // Handle unclosed code block
    if (inCodeBlock) {
        const width = Math.max(40, ...codeBlockLines.map(l => l.length + 2));
        result.push(`${DIM}┌${'─'.repeat(width)}┐${RESET}`);
        if (codeBlockLang) {
            const langPad = ' '.repeat(width - codeBlockLang.length - 1);
            result.push(`${DIM}│${RESET} ${CYAN}${codeBlockLang}${RESET}${langPad}${DIM}│${RESET}`);
            result.push(`${DIM}├${'─'.repeat(width)}┤${RESET}`);
        }
        for (const codeLine of codeBlockLines) {
            const pad = ' '.repeat(width - codeLine.length - 1);
            result.push(`${DIM}│${RESET} ${CYAN}${codeLine}${RESET}${pad}${DIM}│${RESET}`);
        }
        result.push(`${DIM}└${'─'.repeat(width)}┘${RESET}`);
    }

    return result.join('\n');
}

/**
 * Parse a table row into cells
 */
function parseTableRow(line: string): string[] | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') && !trimmed.endsWith('|')) {
        // Must have at least one pipe and look like a table
        if (!trimmed.includes('|')) return null;
    }

    // Split by pipe, trim each cell
    const cells = trimmed
        .split('|')
        .map(c => c.trim())
        .filter((_, i, arr) => {
            // Remove empty first/last elements from |cell|cell|
            if (i === 0 && arr[0] === '') return false;
            if (i === arr.length - 1 && arr[arr.length - 1] === '') return false;
            return true;
        });

    return cells.length > 0 ? cells : null;
}

/**
 * Check if a line is a table separator (|---|---|)
 */
function isTableSeparator(line: string): boolean {
    return /^\|?[\s:-]+\|[\s:|:-]+\|?$/.test(line.trim());
}

/**
 * Parse column alignments from separator row
 */
function parseAlignments(line: string): ('left' | 'center' | 'right')[] {
    const cells = line.split('|').filter(c => c.trim());
    return cells.map(cell => {
        const trimmed = cell.trim();
        const left = trimmed.startsWith(':');
        const right = trimmed.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });
}

/**
 * Strip markdown syntax to get display width
 */
function stripMarkdown(text: string): string {
    return text
        .replace(/`([^`]+)`/g, '$1')           // inline code
        .replace(/\*\*\*([^*]+)\*\*\*/g, '$1') // bold+italic
        .replace(/\*\*([^*]+)\*\*/g, '$1')     // bold
        .replace(/__([^_]+)__/g, '$1')         // bold
        .replace(/\*([^*]+)\*/g, '$1')         // italic
        .replace(/_([^_]+)_/g, '$1')           // italic
        .replace(/~~([^~]+)~~/g, '$1')         // strikethrough
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1'); // images
}

/**
 * Render a table with box-drawing characters
 */
function renderTable(rows: string[][], alignments: ('left' | 'center' | 'right')[]): string[] {
    if (rows.length === 0) return [];

    // Calculate column widths based on display width (markdown stripped)
    const colCount = Math.max(...rows.map(r => r.length));
    const colWidths: number[] = [];

    for (let col = 0; col < colCount; col++) {
        let maxWidth = 0;
        for (const row of rows) {
            const cell = row[col] || '';
            const displayText = stripMarkdown(cell);
            maxWidth = Math.max(maxWidth, displayText.length);
        }
        colWidths.push(Math.max(maxWidth, 3)); // Minimum width of 3
    }

    const result: string[] = [];

    // Top border
    result.push(
        `${DIM}┌${colWidths.map(w => '─'.repeat(w + 2)).join('┬')}┐${RESET}`
    );

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        const isHeader = rowIdx === 0;

        // Cell content
        const cells = colWidths.map((width, colIdx) => {
            const cell = row[colIdx] || '';
            const rendered = renderInline(cell);
            const displayWidth = stripMarkdown(cell).length;
            const padding = width - displayWidth;
            const align = alignments[colIdx] || 'left';

            let padded: string;
            if (align === 'right') {
                padded = ' '.repeat(padding) + rendered;
            } else if (align === 'center') {
                const leftPad = Math.floor(padding / 2);
                const rightPad = padding - leftPad;
                padded = ' '.repeat(leftPad) + rendered + ' '.repeat(rightPad);
            } else {
                padded = rendered + ' '.repeat(padding);
            }

            if (isHeader) {
                return `${BOLD}${padded}${BOLD_OFF}`;
            }
            return padded;
        });

        result.push(`${DIM}│${RESET} ${cells.join(` ${DIM}│${RESET} `)} ${DIM}│${RESET}`);

        // Separator after header
        if (isHeader && rows.length > 1) {
            result.push(
                `${DIM}├${colWidths.map(w => '─'.repeat(w + 2)).join('┼')}┤${RESET}`
            );
        }
    }

    // Bottom border
    result.push(
        `${DIM}└${colWidths.map(w => '─'.repeat(w + 2)).join('┴')}┘${RESET}`
    );

    return result;
}

/**
 * Render inline markdown elements (bold, italic, code, links)
 */
function renderInline(text: string): string {
    // Inline code (must be before bold/italic to avoid conflicts)
    text = text.replace(/`([^`]+)`/g, `${CYAN}$1${COLOR_OFF}`);

    // Bold + italic
    text = text.replace(/\*\*\*([^*]+)\*\*\*/g, `${BOLD}${ITALIC}$1${ITALIC_OFF}${BOLD_OFF}`);

    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${BOLD_OFF}`);
    text = text.replace(/__([^_]+)__/g, `${BOLD}$1${BOLD_OFF}`);

    // Italic
    text = text.replace(/\*([^*]+)\*/g, `${ITALIC}$1${ITALIC_OFF}`);
    text = text.replace(/_([^_]+)_/g, `${ITALIC}$1${ITALIC_OFF}`);

    // Strikethrough
    text = text.replace(/~~([^~]+)~~/g, `${DIM}$1${RESET}`);

    // Links [text](url) - show text underlined, url dimmed
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${UNDERLINE_OFF} ${DIM}($2)${RESET}`);

    // Images ![alt](url) - just show as [image: alt]
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, `${DIM}[image: $1]${RESET}`);

    return text;
}
