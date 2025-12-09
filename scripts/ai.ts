/**
 * AI CLI - Interactive interface to Prior
 *
 * Connects to Prior on port 7777 via HTTP and provides a Claude Code-like
 * interactive experience.
 */

import * as readline from 'readline';

const PORT = 7777;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

// ANSI colors
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

let rl: readline.Interface | null = null;

async function checkConnection(): Promise<boolean> {
    // Just check if the port is open with a HEAD request (or OPTIONS)
    // Don't send a task - that would trigger the LLM
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(BASE_URL, {
            method: 'OPTIONS',
            signal: controller.signal,
        });

        clearTimeout(timeout);
        // Any response (even 4xx/5xx) means the server is up
        return true;
    }
    catch (err) {
        const error = err as Error;
        // Connection refused means server is down
        // Aborted means timeout (also treat as down)
        if (error.name === 'AbortError' || error.message.includes('ECONNREFUSED')) {
            return false;
        }
        // Other errors (like 405 Method Not Allowed) mean server is up
        return true;
    }
}

function displayResponse(response: Record<string, unknown>): void {
    console.log(); // blank line before response

    if (response.status === 'error') {
        console.log(`${RED}Error: ${response.error || response.message || 'Unknown error'}${RESET}`);
        return;
    }

    // Display the result
    if (response.result) {
        console.log(`${GREEN}${response.result}${RESET}`);
    }

    // Display tool calls if any
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
        for (const call of response.toolCalls) {
            console.log(`${DIM}[tool: ${call.name}]${RESET}`);
        }
    }

    console.log(); // blank line after response
}

function promptUser(): void {
    rl?.prompt();
}

async function sendMessage(task: string): Promise<void> {
    try {
        const response = await fetch(BASE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task }),
        });

        const data = await response.json() as Record<string, unknown>;
        displayResponse(data);
    }
    catch (err) {
        const error = err as Error;
        if (error.message.includes('ECONNREFUSED')) {
            console.log(`${RED}Connection lost. Prior may have stopped.${RESET}`);
        }
        else {
            console.log(`${RED}Error: ${error.message}${RESET}`);
        }
    }

    promptUser();
}

async function main(): Promise<void> {
    console.log(`${CYAN}╭─────────────────────────────────────╮${RESET}`);
    console.log(`${CYAN}│${RESET}          ${YELLOW}Prior AI CLI${RESET}              ${CYAN}│${RESET}`);
    console.log(`${CYAN}│${RESET}  ${DIM}Type your message, press Enter${RESET}    ${CYAN}│${RESET}`);
    console.log(`${CYAN}│${RESET}  ${DIM}Ctrl+C to exit${RESET}                     ${CYAN}│${RESET}`);
    console.log(`${CYAN}╰─────────────────────────────────────╯${RESET}`);
    console.log();

    const connected = await checkConnection();
    if (!connected) {
        console.log(`${RED}Could not connect to Prior on port ${PORT}${RESET}`);
        console.log(`${DIM}Make sure the OS is running: bun run start:sqlite${RESET}`);
        process.exit(1);
    }

    console.log(`${DIM}Connected to Prior on ${HOST}:${PORT}${RESET}\n`);

    rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `${CYAN}>${RESET} `,
    });

    rl.on('line', async (line) => {
        const trimmed = line.trim();

        if (!trimmed) {
            promptUser();
            return;
        }

        if (trimmed === '/quit' || trimmed === '/exit') {
            console.log(`${DIM}Goodbye${RESET}`);
            process.exit(0);
        }

        if (trimmed === '/help') {
            console.log(`${DIM}Commands:${RESET}`);
            console.log(`  ${DIM}/help${RESET}  - Show this help`);
            console.log(`  ${DIM}/quit${RESET}  - Exit the CLI`);
            console.log(`  ${DIM}/clear${RESET} - Clear screen`);
            console.log();
            promptUser();
            return;
        }

        if (trimmed === '/clear') {
            console.clear();
            promptUser();
            return;
        }

        await sendMessage(trimmed);
    });

    rl.on('close', () => {
        console.log(`\n${DIM}Goodbye${RESET}`);
        process.exit(0);
    });

    promptUser();
}

main();
