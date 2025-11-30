/**
 * TTY Profile & Session Initialization
 *
 * Handles:
 * - Home directory creation
 * - .profile loading and execution
 * - Command history load/save
 * - Session mount management
 */

import type { Session, SessionMount, TTYStream, CommandIO } from './types.js';
import type { FS } from '@src/lib/fs/index.js';
import type { System } from '@src/lib/system.js';
import { runTransaction } from '@src/lib/transaction.js';
import { LocalMount } from '@src/lib/fs/index.js';
import { BinMount } from '@src/lib/fs/mounts/bin-mount.js';
import { ProcMount } from '@src/lib/fs/mounts/proc-mount.js';
import { FindMount } from '@src/lib/fs/mounts/find-mount.js';
import { executeLine, createIO, getCommandNamesSync } from './executor.js';

/**
 * Write to TTY stream with CRLF
 */
function writeToStream(stream: TTYStream, text: string): void {
    const normalized = text.replace(/(?<!\r)\n/g, '\r\n');
    stream.write(normalized);
}

/**
 * Initialize session after login
 *
 * Creates home directory, loads saved mounts, loads history, and executes .profile
 */
export async function initializeSession(stream: TTYStream, session: Session): Promise<void> {
    const home = session.env['HOME'] || `/home/${session.username}`;

    await ensureHomeDirectory(session, home);
    session.cwd = home;

    await loadSavedMounts(session);
    await loadHistory(session);
    await loadProfile(stream, session);
}

/**
 * Ensure home directory exists
 */
async function ensureHomeDirectory(session: Session, home: string): Promise<void> {
    if (!session.systemInit) return;

    try {
        await runTransaction(session.systemInit, async (system) => {
            if (!await system.fs.exists('/home')) {
                await system.fs.mkdir('/home');
            }
            if (!await system.fs.exists(home)) {
                await system.fs.mkdir(home);
            }
        });
    } catch {
        // Ignore errors - we'll just start in a non-existent dir
    }
}

/**
 * Load and execute ~/.profile
 *
 * Uses executeLine for each line, giving full scripting support
 */
async function loadProfile(stream: TTYStream, session: Session): Promise<void> {
    if (!session.systemInit) return;

    const profilePath = `/home/${session.username}/.profile`;

    try {
        await runTransaction(session.systemInit, async (system) => {
            // Check if .profile exists
            let content: string;
            try {
                const buffer = await system.fs.read(profilePath);
                content = buffer.toString();
            } catch {
                // No .profile file
                return;
            }

            // Apply session mounts
            applySessionMounts(session, system.fs, system);

            // Create IO that discards stdout, shows stderr
            const io = createIO();
            io.stdin.end();
            io.stderr.on('data', (chunk) => writeToStream(stream, chunk.toString()));

            // Execute each line
            const lines = content.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) continue;
                if (trimmed.startsWith('#!')) continue; // shebang

                await executeLine(session, trimmed, io, {
                    fs: system.fs,
                    useTransaction: false,
                });
            }
        });
    } catch {
        // Ignore profile load errors
    }
}

/**
 * Load command history from ~/.history
 * Respects HISTSIZE environment variable (default: 1000)
 */
export async function loadHistory(session: Session): Promise<void> {
    if (!session.systemInit) return;

    const histSize = parseInt(session.env['HISTSIZE'] || '1000', 10) || 1000;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const historyPath = `/home/${session.username}/.history`;

            try {
                const content = await system.fs.read(historyPath);
                const lines = content.toString().split('\n').filter(Boolean);
                // Limit to HISTSIZE
                session.history = lines.slice(-histSize);
            } catch {
                session.history = [];
            }
        });
    } catch {
        session.history = [];
    }
}

/**
 * Save command history to ~/.history
 * Respects HISTFILESIZE environment variable (default: 2000)
 */
export async function saveHistory(session: Session): Promise<void> {
    if (!session.systemInit || session.history.length === 0) return;

    const histFileSize = parseInt(session.env['HISTFILESIZE'] || '2000', 10) || 2000;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const historyPath = `/home/${session.username}/.history`;
            const homePath = `/home/${session.username}`;

            if (!await system.fs.exists(homePath)) {
                await system.fs.mkdir(homePath);
            }

            // Limit to HISTFILESIZE
            const trimmed = session.history.slice(-histFileSize);
            await system.fs.write(historyPath, trimmed.join('\n') + '\n');
        });
    } catch {
        // Ignore save errors
    }
}

/**
 * Apply session-specific mounts to a FS instance
 *
 * Mounts:
 * - /bin: Built-in commands
 * - /proc: Process filesystem with /proc/self
 * - User mounts: Local and find mounts from mount command
 *
 * @param session - User session
 * @param fs - Filesystem instance
 * @param system - System context (required for find mounts)
 */
export function applySessionMounts(session: Session, fs: FS, system?: System): void {
    // Mount /bin with command names (uses cached names from lazy load)
    // If not yet loaded, BinMount will show empty /bin until first command execution
    fs.mount('/bin', new BinMount(getCommandNamesSync()));

    // Re-mount /proc with session PID for /proc/self
    if (session.pid !== null) {
        fs.mount('/proc', new ProcMount(session.tenant, session.pid));
    }

    // Apply user-created mounts
    for (const [virtualPath, mountInfo] of session.mounts) {
        if (mountInfo.type === 'local') {
            const mount = new LocalMount(mountInfo.path, {
                writable: !mountInfo.readonly,
            });
            fs.mount(virtualPath, mount);
        } else if (mountInfo.type === 'find' && system) {
            const mount = new FindMount(system, mountInfo.model, mountInfo.query);
            fs.mount(virtualPath, mount);
        }
    }
}

// =============================================================================
// MOUNT PERSISTENCE
// =============================================================================

const MOUNTS_FILE = '.config/mounts.json';

/**
 * Load saved mounts from ~/.config/mounts.json
 */
export async function loadSavedMounts(session: Session): Promise<void> {
    if (!session.systemInit) return;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const mountsPath = `/home/${session.username}/${MOUNTS_FILE}`;

            try {
                const content = await system.fs.read(mountsPath);
                const saved = JSON.parse(content.toString()) as Record<string, SessionMount>;

                // Load into session mounts
                for (const [path, config] of Object.entries(saved)) {
                    session.mounts.set(path, config);
                }
            } catch {
                // No saved mounts file - that's fine
            }
        });
    } catch {
        // Ignore load errors
    }
}

/**
 * Save a mount to ~/.config/mounts.json
 */
export async function saveMountConfig(session: Session, mountPath: string, config: SessionMount): Promise<void> {
    if (!session.systemInit) return;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const configDir = `/home/${session.username}/.config`;
            const mountsPath = `${configDir}/${MOUNTS_FILE.split('/')[1]}`;

            // Ensure .config directory exists
            if (!await system.fs.exists(configDir)) {
                await system.fs.mkdir(configDir);
            }

            // Load existing mounts
            let saved: Record<string, SessionMount> = {};
            try {
                const content = await system.fs.read(mountsPath);
                saved = JSON.parse(content.toString());
            } catch {
                // No existing file
            }

            // Add/update mount
            saved[mountPath] = config;

            // Save
            await system.fs.write(mountsPath, JSON.stringify(saved, null, 2) + '\n');
        });
    } catch {
        // Ignore save errors - mount still works for session
    }
}

/**
 * Remove a mount from ~/.config/mounts.json
 */
export async function removeMountConfig(session: Session, mountPath: string): Promise<void> {
    if (!session.systemInit) return;

    try {
        await runTransaction(session.systemInit, async (system) => {
            const mountsPath = `/home/${session.username}/${MOUNTS_FILE}`;

            // Load existing mounts
            let saved: Record<string, SessionMount> = {};
            try {
                const content = await system.fs.read(mountsPath);
                saved = JSON.parse(content.toString());
            } catch {
                return; // No file, nothing to remove
            }

            // Remove mount
            delete saved[mountPath];

            // Save (or delete if empty)
            if (Object.keys(saved).length === 0) {
                await system.fs.unlink(mountsPath);
            } else {
                await system.fs.write(mountsPath, JSON.stringify(saved, null, 2) + '\n');
            }
        });
    } catch {
        // Ignore errors
    }
}

/**
 * Check if a mount path is saved in ~/.config/mounts.json
 */
export async function isMountSaved(session: Session, mountPath: string): Promise<boolean> {
    if (!session.systemInit) return false;

    try {
        let result = false;
        await runTransaction(session.systemInit, async (system) => {
            const mountsPath = `/home/${session.username}/${MOUNTS_FILE}`;

            try {
                const content = await system.fs.read(mountsPath);
                const saved = JSON.parse(content.toString());
                result = mountPath in saved;
            } catch {
                result = false;
            }
        });
        return result;
    } catch {
        return false;
    }
}

// =============================================================================
// RE-EXPORTS FROM MEMORY.TS (for backward compatibility)
// =============================================================================

export type { STMAlarm, STMDataFull, STMData } from './memory.js';
export {
    loadSTM,
    loadSTMFull,
    saveSTM,
    saveSTMFull,
    formatAlarmsForPrompt,
    autoCoalesce,
} from './memory.js';
