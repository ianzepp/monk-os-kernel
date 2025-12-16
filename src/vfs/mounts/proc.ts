/**
 * ProcMount - Synthetic /proc filesystem backed by kernel ProcessTable
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * ProcMount provides a virtual /proc filesystem that exposes kernel process
 * information as files. Unlike HostMount which bridges to the host filesystem,
 * ProcMount generates all content on-the-fly from the kernel's ProcessTable.
 *
 * This follows the Linux /proc model where process information is exposed
 * through a filesystem interface, enabling tools like `ps`, `top`, and
 * debugging utilities to work through standard file operations.
 *
 * PATH STRUCTURE
 * ==============
 * /proc                     - Directory listing all process UUIDs + "self"
 * /proc/self                - Alias for caller's process (resolved dynamically)
 * /proc/{uuid}              - Directory for a specific process
 * /proc/{uuid}/stat         - Process status (JSON)
 * /proc/{uuid}/env          - Environment variables (KEY=VALUE per line)
 * /proc/{uuid}/cwd          - Current working directory (path string)
 * /proc/{uuid}/cmdline      - Command line (cmd + args, null-separated)
 * /proc/{uuid}/path/        - Directory of PATH entries (symlinks)
 * /proc/{uuid}/path/{name}  - Symlink to a PATH directory
 * /proc/{uuid}/fd/          - Directory of open file descriptors (symlinks)
 * /proc/{uuid}/fd/{n}       - Symlink to handle UUID
 *
 * WRITABLE PATHS
 * ==============
 * The /proc/{uuid}/path/ directory is writable for the owning process:
 * - symlink(target, '/proc/self/path/50-httpd') adds PATH entry
 * - unlink('/proc/self/path/50-httpd') removes PATH entry
 * - Filenames determine search order (sorted alphabetically)
 *
 * @module vfs/mounts/proc
 */

import type { FileHandle, OpenFlags, SeekWhence } from '@src/vfs/handle.js';
import type { ModelStat } from '@src/vfs/model.js';
import type { ProcessTable } from '@src/kernel/process-table.js';
import type { Process } from '@src/kernel/types.js';
import { KERNEL_ID } from '@src/kernel/types.js';
import { ENOENT, EACCES, EISDIR, ENOTDIR, EBADF, EROFS, EPERM, EEXIST } from '@src/hal/errors.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const PROC_ID_PREFIX = 'proc:';
const PROC_HANDLE_PREFIX = 'proc-handle:';
const PROC_FILE_OWNER = KERNEL_ID;

/** Files directly under /proc/{uuid}/ */
const PROC_FILES = ['stat', 'env', 'cwd', 'cmdline'] as const;

type ProcFileName = typeof PROC_FILES[number];

/** Directories under /proc/{uuid}/ */
const PROC_DIRS = ['path', 'fd'] as const;

type ProcDirName = typeof PROC_DIRS[number];

// =============================================================================
// TYPES
// =============================================================================

export interface ProcMount {
    vfsPath: string;
    processTable: ProcessTable;
}

type ParsedPathType =
    | 'root'           // /proc
    | 'self'           // /proc/self (needs resolution)
    | 'process'        // /proc/{uuid}
    | 'file'           // /proc/{uuid}/stat, etc.
    | 'subdir'         // /proc/{uuid}/path, /proc/{uuid}/fd
    | 'subdir_entry';  // /proc/{uuid}/path/{name}, /proc/{uuid}/fd/{n}

interface ParsedProcPath {
    type: ParsedPathType;
    processId?: string;
    fileName?: ProcFileName;
    dirName?: ProcDirName;
    entryName?: string;
}

// =============================================================================
// MOUNT CONFIGURATION
// =============================================================================

export function createProcMount(vfsPath: string, processTable: ProcessTable): ProcMount {
    const normalizedPath = vfsPath.replace(/\/+$/, '') || '/proc';

    return { vfsPath: normalizedPath, processTable };
}

// =============================================================================
// PATH RESOLUTION
// =============================================================================

export function isUnderProcMount(mount: ProcMount, vfsPath: string): boolean {
    if (vfsPath === mount.vfsPath) {
        return true;
    }

    return vfsPath.startsWith(mount.vfsPath + '/');
}

/**
 * Resolve 'self' to caller's process ID.
 */
function resolveProcessId(
    mount: ProcMount,
    id: string,
    caller: string,
): string | null {
    if (id === 'self') {
        // Resolve to caller's UUID
        const proc = mount.processTable.get(caller);

        return proc ? proc.id : null;
    }

    return mount.processTable.has(id) ? id : null;
}

/**
 * Parse a proc path into its components.
 */
function parseProcPath(
    mount: ProcMount,
    vfsPath: string,
    caller: string,
): ParsedProcPath | null {
    if (vfsPath === mount.vfsPath) {
        return { type: 'root' };
    }

    const prefix = mount.vfsPath + '/';

    if (!vfsPath.startsWith(prefix)) {
        return null;
    }

    const relativePath = vfsPath.slice(prefix.length);
    const parts = relativePath.split('/').filter(Boolean);

    if (parts.length === 0) {
        return { type: 'root' };
    }

    // Resolve 'self' to actual process ID
    const firstPart = parts[0]!;
    const processId = resolveProcessId(mount, firstPart, caller);

    if (!processId) {
        // Keep 'self' for error messages if caller not found
        if (firstPart === 'self') {
            return { type: 'self' };
        }

        return null;
    }

    if (parts.length === 1) {
        return { type: 'process', processId };
    }

    const secondPart = parts[1];

    // Check if it's a file (stat, env, cwd, cmdline)
    if (PROC_FILES.includes(secondPart as ProcFileName)) {
        if (parts.length === 2) {
            return { type: 'file', processId, fileName: secondPart as ProcFileName };
        }

        return null; // Too many components
    }

    // Check if it's a directory (path, fd)
    if (PROC_DIRS.includes(secondPart as ProcDirName)) {
        if (parts.length === 2) {
            return { type: 'subdir', processId, dirName: secondPart as ProcDirName };
        }

        if (parts.length === 3) {
            return {
                type: 'subdir_entry',
                processId,
                dirName: secondPart as ProcDirName,
                entryName: parts[2],
            };
        }

        return null; // Too many components
    }

    return null;
}

// =============================================================================
// FILE OPERATIONS
// =============================================================================

export async function procStat(
    mount: ProcMount,
    vfsPath: string,
    caller: string = KERNEL_ID,
): Promise<ModelStat> {
    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    const now = Date.now();

    switch (parsed.type) {
        case 'root':
            return {
                id: `${PROC_ID_PREFIX}root`,
                model: 'folder',
                name: 'proc',
                parent: null,
                owner: PROC_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };

        case 'self':
            throw new ENOENT(`Process not found for caller: ${caller}`);

        case 'process': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            return {
                id: `${PROC_ID_PREFIX}${proc.id}`,
                model: 'folder',
                name: proc.id,
                parent: null,
                owner: PROC_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };
        }

        case 'file': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            return {
                id: `${PROC_ID_PREFIX}${proc.id}/${parsed.fileName}`,
                model: 'file',
                name: parsed.fileName!,
                parent: null,
                owner: PROC_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };
        }

        case 'subdir': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            return {
                id: `${PROC_ID_PREFIX}${proc.id}/${parsed.dirName}`,
                model: 'folder',
                name: parsed.dirName!,
                parent: null,
                owner: PROC_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };
        }

        case 'subdir_entry': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            // Verify entry exists
            if (parsed.dirName === 'path') {
                if (!proc.pathDirs.has(parsed.entryName!)) {
                    throw new ENOENT(`No such PATH entry: ${parsed.entryName}`);
                }

                return {
                    id: `${PROC_ID_PREFIX}${proc.id}/path/${parsed.entryName}`,
                    model: 'link',
                    name: parsed.entryName!,
                    parent: null,
                    owner: PROC_FILE_OWNER,
                    size: 0,
                    mtime: now,
                    ctime: now,
                    target: proc.pathDirs.get(parsed.entryName!),
                };
            }
            else if (parsed.dirName === 'fd') {
                const fd = parseInt(parsed.entryName!, 10);

                if (isNaN(fd) || !proc.handles.has(fd)) {
                    throw new ENOENT(`No such fd: ${parsed.entryName}`);
                }

                return {
                    id: `${PROC_ID_PREFIX}${proc.id}/fd/${fd}`,
                    model: 'link',
                    name: parsed.entryName!,
                    parent: null,
                    owner: PROC_FILE_OWNER,
                    size: 0,
                    mtime: now,
                    ctime: now,
                    target: proc.handles.get(fd),
                };
            }

            throw new ENOENT(`No such file: ${vfsPath}`);
        }
    }
}

export async function* procReaddir(
    mount: ProcMount,
    vfsPath: string,
    caller: string = KERNEL_ID,
): AsyncIterable<ModelStat> {
    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed) {
        throw new ENOENT(`No such directory: ${vfsPath}`);
    }

    const now = Date.now();

    switch (parsed.type) {
        case 'root':
            // List 'self' alias
            yield {
                id: `${PROC_ID_PREFIX}self`,
                model: 'link',
                name: 'self',
                parent: null,
                owner: PROC_FILE_OWNER,
                size: 0,
                mtime: now,
                ctime: now,
            };
            // List all process UUIDs
            for (const proc of mount.processTable.all()) {
                yield {
                    id: `${PROC_ID_PREFIX}${proc.id}`,
                    model: 'folder',
                    name: proc.id,
                    parent: null,
                    owner: PROC_FILE_OWNER,
                    size: 0,
                    mtime: now,
                    ctime: now,
                };
            }

            break;

        case 'self':
            throw new ENOENT(`Process not found for caller: ${caller}`);

        case 'process': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            // List files
            for (const fileName of PROC_FILES) {
                yield {
                    id: `${PROC_ID_PREFIX}${proc.id}/${fileName}`,
                    model: 'file',
                    name: fileName,
                    parent: null,
                    owner: PROC_FILE_OWNER,
                    size: 0,
                    mtime: now,
                    ctime: now,
                };
            }

            // List directories
            for (const dirName of PROC_DIRS) {
                yield {
                    id: `${PROC_ID_PREFIX}${proc.id}/${dirName}`,
                    model: 'folder',
                    name: dirName,
                    parent: null,
                    owner: PROC_FILE_OWNER,
                    size: 0,
                    mtime: now,
                    ctime: now,
                };
            }

            break;
        }

        case 'subdir': {
            const proc = mount.processTable.get(parsed.processId!);

            if (!proc) {
                throw new ENOENT(`No such process: ${parsed.processId}`);
            }

            if (parsed.dirName === 'path') {
                // List PATH entries as symlinks (sorted)
                const entries = Array.from(proc.pathDirs.entries()).sort((a, b) =>
                    a[0].localeCompare(b[0]),
                );

                for (const [name, target] of entries) {
                    yield {
                        id: `${PROC_ID_PREFIX}${proc.id}/path/${name}`,
                        model: 'link',
                        name,
                        parent: null,
                        owner: PROC_FILE_OWNER,
                        size: 0,
                        mtime: now,
                        ctime: now,
                        target,
                    };
                }
            }
            else if (parsed.dirName === 'fd') {
                // List fd entries as symlinks (sorted by fd number)
                const entries = Array.from(proc.handles.entries()).sort((a, b) => a[0] - b[0]);

                for (const [fd, handleId] of entries) {
                    yield {
                        id: `${PROC_ID_PREFIX}${proc.id}/fd/${fd}`,
                        model: 'link',
                        name: String(fd),
                        parent: null,
                        owner: PROC_FILE_OWNER,
                        size: 0,
                        mtime: now,
                        ctime: now,
                        target: handleId,
                    };
                }
            }

            break;
        }

        case 'file':
        case 'subdir_entry':
            throw new ENOTDIR(`Not a directory: ${vfsPath}`);
    }
}

export async function procOpen(
    mount: ProcMount,
    vfsPath: string,
    flags: OpenFlags,
    caller: string = KERNEL_ID,
): Promise<FileHandle> {
    if (flags.write) {
        throw new EROFS(`Proc filesystem is read-only: ${vfsPath}`);
    }

    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed) {
        throw new ENOENT(`No such file: ${vfsPath}`);
    }

    if (parsed.type === 'root' || parsed.type === 'process' || parsed.type === 'subdir') {
        throw new EISDIR(`Is a directory: ${vfsPath}`);
    }

    if (parsed.type === 'self') {
        throw new ENOENT(`Process not found for caller: ${caller}`);
    }

    const proc = mount.processTable.get(parsed.processId!);

    if (!proc) {
        throw new ENOENT(`No such process: ${parsed.processId}`);
    }

    if (parsed.type === 'file') {
        return new ProcFileHandle(mount, vfsPath, proc.id, parsed.fileName!, flags);
    }

    // subdir_entry - return content as readlink target
    if (parsed.type === 'subdir_entry') {
        return new ProcLinkHandle(mount, vfsPath, proc, parsed.dirName!, parsed.entryName!, flags);
    }

    throw new ENOENT(`No such file: ${vfsPath}`);
}

// =============================================================================
// SYMLINK OPERATIONS (for /proc/{uuid}/path/)
// =============================================================================

/**
 * Create a symlink in /proc/{uuid}/path/
 */
export async function procSymlink(
    mount: ProcMount,
    target: string,
    vfsPath: string,
    caller: string,
): Promise<void> {
    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed || parsed.type !== 'subdir_entry' || parsed.dirName !== 'path') {
        throw new EPERM(`Cannot create symlink here: ${vfsPath}`);
    }

    const proc = mount.processTable.get(parsed.processId!);

    if (!proc) {
        throw new ENOENT(`No such process: ${parsed.processId}`);
    }

    // Only the process itself (or kernel) can modify its PATH
    if (caller !== KERNEL_ID && caller !== proc.id) {
        throw new EPERM(`Cannot modify another process's PATH`);
    }

    if (proc.pathDirs.has(parsed.entryName!)) {
        throw new EEXIST(`PATH entry already exists: ${parsed.entryName}`);
    }

    proc.pathDirs.set(parsed.entryName!, target);
}

/**
 * Remove a symlink from /proc/{uuid}/path/
 */
export async function procUnlink(
    mount: ProcMount,
    vfsPath: string,
    caller: string,
): Promise<void> {
    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed || parsed.type !== 'subdir_entry' || parsed.dirName !== 'path') {
        throw new EPERM(`Cannot unlink here: ${vfsPath}`);
    }

    const proc = mount.processTable.get(parsed.processId!);

    if (!proc) {
        throw new ENOENT(`No such process: ${parsed.processId}`);
    }

    // Only the process itself (or kernel) can modify its PATH
    if (caller !== KERNEL_ID && caller !== proc.id) {
        throw new EPERM(`Cannot modify another process's PATH`);
    }

    if (!proc.pathDirs.has(parsed.entryName!)) {
        throw new ENOENT(`No such PATH entry: ${parsed.entryName}`);
    }

    proc.pathDirs.delete(parsed.entryName!);
}

/**
 * Read symlink target
 */
export async function procReadlink(
    mount: ProcMount,
    vfsPath: string,
    caller: string,
): Promise<string> {
    const parsed = parseProcPath(mount, vfsPath, caller);

    if (!parsed || parsed.type !== 'subdir_entry') {
        throw new ENOENT(`Not a symlink: ${vfsPath}`);
    }

    const proc = mount.processTable.get(parsed.processId!);

    if (!proc) {
        throw new ENOENT(`No such process: ${parsed.processId}`);
    }

    if (parsed.dirName === 'path') {
        const target = proc.pathDirs.get(parsed.entryName!);

        if (!target) {
            throw new ENOENT(`No such PATH entry: ${parsed.entryName}`);
        }

        return target;
    }
    else if (parsed.dirName === 'fd') {
        const fd = parseInt(parsed.entryName!, 10);
        const handleId = proc.handles.get(fd);

        if (!handleId) {
            throw new ENOENT(`No such fd: ${parsed.entryName}`);
        }

        return handleId;
    }

    throw new ENOENT(`Not a symlink: ${vfsPath}`);
}

// =============================================================================
// FILE HANDLE IMPLEMENTATIONS
// =============================================================================

/**
 * Handle for regular proc files (stat, env, cwd, cmdline)
 */
class ProcFileHandle implements FileHandle {
    readonly id: string;
    readonly path: string;
    readonly flags: OpenFlags;

    private _closed = false;
    private _position = 0;
    private _content: Uint8Array | null = null;

    private readonly mount: ProcMount;
    private readonly processId: string;
    private readonly fileName: ProcFileName;

    constructor(
        mount: ProcMount,
        vfsPath: string,
        processId: string,
        fileName: ProcFileName,
        flags: OpenFlags,
    ) {
        this.mount = mount;
        this.processId = processId;
        this.fileName = fileName;
        this.id = `${PROC_HANDLE_PREFIX}${vfsPath}:${Date.now()}`;
        this.path = vfsPath;
        this.flags = flags;
    }

    get closed(): boolean {
        return this._closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Not opened for reading');
        }

        if (this._content === null) {
            this._content = this.generateContent();
        }

        const remaining = this._content.length - this._position;

        if (remaining <= 0) {
            return new Uint8Array(0);
        }

        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;
        const result = this._content.slice(this._position, this._position + toRead);

        this._position += toRead;

        return result;
    }

    async write(_data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        throw new EROFS('Proc filesystem is read-only');
    }

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (this._content === null) {
            this._content = this.generateContent();
        }

        let newPosition: number;

        switch (whence) {
            case 'start': newPosition = offset; break;
            case 'current': newPosition = this._position + offset; break;
            case 'end': newPosition = this._content.length + offset; break;
        }

        if (newPosition < 0) {
            newPosition = 0;
        }

        this._position = newPosition;

        return this._position;
    }

    async tell(): Promise<number> {
        return this._position;
    }

    async sync(): Promise<void> {}

    async close(): Promise<void> {
        this._closed = true;
        this._content = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private generateContent(): Uint8Array {
        const proc = this.mount.processTable.get(this.processId);

        if (!proc) {
            return new TextEncoder().encode('(process not found)\n');
        }

        let text: string;

        switch (this.fileName) {
            case 'stat':
                text = JSON.stringify({
                    id: proc.id,
                    parent: proc.parent,
                    state: proc.state,
                    cmd: proc.cmd,
                    cwd: proc.cwd,
                    exitCode: proc.exitCode,
                }, null, 2) + '\n';
                break;
            case 'env':
                text = Object.entries(proc.env).map(([k, v]) => `${k}=${v}`).join('\n');
                if (text) {
                    text += '\n';
                }

                break;
            case 'cwd':
                text = proc.cwd + '\n';
                break;
            case 'cmdline':
                text = [proc.cmd, ...proc.args].join('\0');
                if (text) {
                    text += '\0';
                }

                break;
            default:
                text = '(unknown proc file)\n';
        }

        return new TextEncoder().encode(text);
    }
}

/**
 * Handle for symlink entries (path/*, fd/*)
 * Reading returns the symlink target.
 */
class ProcLinkHandle implements FileHandle {
    readonly id: string;
    readonly path: string;
    readonly flags: OpenFlags;

    private _closed = false;
    private _position = 0;
    private _content: Uint8Array | null = null;

    private readonly proc: Process;
    private readonly dirName: ProcDirName;
    private readonly entryName: string;

    constructor(
        _mount: ProcMount,
        vfsPath: string,
        proc: Process,
        dirName: ProcDirName,
        entryName: string,
        flags: OpenFlags,
    ) {
        this.proc = proc;
        this.dirName = dirName;
        this.entryName = entryName;
        this.id = `${PROC_HANDLE_PREFIX}${vfsPath}:${Date.now()}`;
        this.path = vfsPath;
        this.flags = flags;
    }

    get closed(): boolean {
        return this._closed;
    }

    async read(size?: number): Promise<Uint8Array> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (!this.flags.read) {
            throw new EACCES('Not opened for reading');
        }

        if (this._content === null) {
            let target: string | undefined;

            if (this.dirName === 'path') {
                target = this.proc.pathDirs.get(this.entryName);
            }
            else if (this.dirName === 'fd') {
                const fd = parseInt(this.entryName, 10);

                target = this.proc.handles.get(fd);
            }

            this._content = new TextEncoder().encode((target ?? '(not found)') + '\n');
        }

        const remaining = this._content.length - this._position;

        if (remaining <= 0) {
            return new Uint8Array(0);
        }

        const toRead = size !== undefined ? Math.min(size, remaining) : remaining;
        const result = this._content.slice(this._position, this._position + toRead);

        this._position += toRead;

        return result;
    }

    async write(_data: Uint8Array): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        throw new EROFS('Proc filesystem is read-only');
    }

    async seek(offset: number, whence: SeekWhence): Promise<number> {
        if (this._closed) {
            throw new EBADF('Handle is closed');
        }

        if (this._content === null) {
            // Generate content to know size
            await this.read(0);
        }

        let newPosition: number;

        switch (whence) {
            case 'start': newPosition = offset; break;
            case 'current': newPosition = this._position + offset; break;
            case 'end': newPosition = (this._content?.length ?? 0) + offset; break;
        }

        if (newPosition < 0) {
            newPosition = 0;
        }

        this._position = newPosition;

        return this._position;
    }

    async tell(): Promise<number> {
        return this._position;
    }

    async sync(): Promise<void> {}

    async close(): Promise<void> {
        this._closed = true;
        this._content = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}
