/**
 * ProcMount - Process table as filesystem
 *
 * Exposes the process table in a Linux /proc-like structure:
 * - /proc/                     → list of PIDs
 * - /proc/self                 → symlink to current session's PID
 * - /proc/{pid}/               → process directory
 * - /proc/{pid}/cmdline        → command and arguments
 * - /proc/{pid}/comm           → command name
 * - /proc/{pid}/cwd            → working directory
 * - /proc/{pid}/environ        → environment variables
 * - /proc/{pid}/status         → human-readable status
 * - /proc/{pid}/stdout         → captured stdout (if available)
 * - /proc/{pid}/stderr         → captured stderr (if available)
 *
 * Read-only mount.
 */

import type { Session } from '@src/lib/tty/types.js';
import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';
import { listProcesses, getProcess, type ProcessRecord } from '@src/lib/process.js';

type ParsedPath =
    | { type: 'root' }
    | { type: 'self' }
    | { type: 'pid'; pid: number }
    | { type: 'file'; pid: number; file: string };

const PROC_FILES = ['cmdline', 'comm', 'cwd', 'environ', 'status', 'stdout', 'stderr'];

export class ProcMount implements Mount {
    constructor(
        private readonly tenant: string,
        private readonly sessionPid: number | null
    ) {}

    async stat(path: string): Promise<FSEntry> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            return {
                name: 'proc',
                type: 'directory',
                size: 0,
                mode: 0o555,
            };
        }

        if (parsed.type === 'self') {
            if (!this.sessionPid) {
                throw new FSError('ENOENT', path);
            }
            return {
                name: 'self',
                type: 'symlink',
                size: 0,
                mode: 0o777,
                target: String(this.sessionPid),
            };
        }

        if (parsed.type === 'pid') {
            const proc = await getProcess(this.tenant, parsed.pid);
            if (!proc) {
                throw new FSError('ENOENT', path);
            }
            return {
                name: String(parsed.pid),
                type: 'directory',
                size: 0,
                mode: 0o555,
                mtime: proc.started_at ? new Date(proc.started_at) : new Date(proc.created_at),
            };
        }

        if (parsed.type === 'file') {
            const proc = await getProcess(this.tenant, parsed.pid);
            if (!proc) {
                throw new FSError('ENOENT', path);
            }

            if (!PROC_FILES.includes(parsed.file)) {
                throw new FSError('ENOENT', path);
            }

            const content = this.getFileContent(proc, parsed.file);
            return {
                name: parsed.file,
                type: 'file',
                size: Buffer.byteLength(content, 'utf8'),
                mode: 0o444,
                mtime: proc.started_at ? new Date(proc.started_at) : new Date(proc.created_at),
            };
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            const procs = await listProcesses(this.tenant);
            const entries: FSEntry[] = procs.map(p => ({
                name: String(p.pid),
                type: 'directory' as const,
                size: 0,
                mode: 0o555,
                mtime: p.started_at ? new Date(p.started_at) : new Date(p.created_at),
            }));

            // Add 'self' symlink if we have a session PID
            if (this.sessionPid) {
                entries.unshift({
                    name: 'self',
                    type: 'symlink',
                    size: 0,
                    mode: 0o777,
                    target: String(this.sessionPid),
                });
            }

            return entries;
        }

        if (parsed.type === 'pid') {
            const proc = await getProcess(this.tenant, parsed.pid);
            if (!proc) {
                throw new FSError('ENOENT', path);
            }

            return PROC_FILES.map(name => ({
                name,
                type: 'file' as const,
                size: 0,
                mode: 0o444,
            }));
        }

        throw new FSError('ENOTDIR', path);
    }

    async read(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'pid') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'self') {
            throw new FSError('EINVAL', path); // Can't read a symlink directly
        }

        if (parsed.type === 'file') {
            const proc = await getProcess(this.tenant, parsed.pid);
            if (!proc) {
                throw new FSError('ENOENT', path);
            }

            if (!PROC_FILES.includes(parsed.file)) {
                throw new FSError('ENOENT', path);
            }

            return this.getFileContent(proc, parsed.file);
        }

        throw new FSError('ENOENT', path);
    }

    async readlink(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'self') {
            if (!this.sessionPid) {
                throw new FSError('ENOENT', path);
            }
            return String(this.sessionPid);
        }

        throw new FSError('EINVAL', path);
    }

    private getFileContent(proc: ProcessRecord, file: string): string {
        switch (file) {
            case 'cmdline':
                // Include comm as first element like Linux /proc
                return [proc.comm, ...proc.cmdline].join('\0') + '\0';
            case 'comm':
                return proc.comm + '\n';
            case 'cwd':
                return proc.cwd + '\n';
            case 'environ':
                if (!proc.environ) return '';
                return Object.entries(proc.environ)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\0') + '\0';
            case 'status':
                return this.formatStatus(proc);
            case 'stdout':
                // Would need to read from the actual file - for now return path
                return proc.stdout || '';
            case 'stderr':
                return proc.stderr || '';
            default:
                return '';
        }
    }

    private formatStatus(proc: ProcessRecord): string {
        const stateNames: Record<string, string> = {
            'R': 'running',
            'S': 'sleeping',
            'Z': 'zombie',
            'T': 'stopped',
            'X': 'dead',
        };

        const lines = [
            `Name:\t${proc.comm}`,
            `State:\t${proc.state} (${stateNames[proc.state] || proc.state})`,
            `Pid:\t${proc.pid}`,
            `PPid:\t${proc.ppid || 0}`,
            `Uid:\t${proc.uid}`,
            `Type:\t${proc.type}`,
        ];

        if (proc.exit_code !== null && proc.exit_code !== undefined) {
            lines.push(`ExitCode:\t${proc.exit_code}`);
        }

        if (proc.error) {
            lines.push(`Error:\t${proc.error}`);
        }

        if (proc.started_at) {
            lines.push(`StartedAt:\t${new Date(proc.started_at).toISOString()}`);
        }

        if (proc.ended_at) {
            lines.push(`EndedAt:\t${new Date(proc.ended_at).toISOString()}`);
        }

        return lines.join('\n') + '\n';
    }

    private parsePath(path: string): ParsedPath {
        const segments = path.split('/').filter(Boolean);

        if (segments.length === 0) {
            return { type: 'root' };
        }

        if (segments[0] === 'self') {
            return { type: 'self' };
        }

        const pid = parseInt(segments[0], 10);
        if (isNaN(pid)) {
            throw new FSError('ENOENT', path);
        }

        if (segments.length === 1) {
            return { type: 'pid', pid };
        }

        if (segments.length === 2) {
            return { type: 'file', pid, file: segments[1] };
        }

        throw new FSError('ENOENT', path);
    }
}
