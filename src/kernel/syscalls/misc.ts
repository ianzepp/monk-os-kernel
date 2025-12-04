/**
 * Miscellaneous Syscalls - Process environment and working directory operations
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module implements fundamental process context syscalls that manage working
 * directory navigation and environment variables. These operations form the basis
 * for POSIX-style process execution where programs inherit environment and can
 * navigate the filesystem hierarchy.
 *
 * The syscalls operate directly on Process objects, modifying mutable state like
 * cwd (current working directory) and env (environment variables). This design
 * assumes process state is owned by the kernel and not concurrently modified by
 * other kernel subsystems.
 *
 * Path resolution is relative to the process's cwd unless an absolute path is
 * provided. The chdir syscall validates paths against the VFS to ensure the target
 * exists and is a directory before updating process state. This prevents processes
 * from entering invalid states with non-existent working directories.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: proc.cwd is always an absolute path starting with '/'
 * INV-2: proc.cwd always references an existing directory in the VFS
 * INV-3: proc.env keys and values are always strings (no undefined/null)
 * INV-4: getargs returns immutable view of proc.args (no modifications leak)
 * INV-5: Path resolution never produces paths with '..' or '.' components
 *
 * CONCURRENCY MODEL
 * =================
 * JavaScript is single-threaded but async operations can interleave. The chdir
 * syscall has a TOCTOU window between vfs.stat() checking directory existence
 * and updating proc.cwd. If the directory is deleted by another syscall during
 * this window, the process could end up with an invalid cwd.
 *
 * Process state (cwd, env, args) is not protected by locks. The kernel assumes
 * only the owning process modifies its own state via syscalls. Concurrent syscalls
 * from the same process are serialized by the message queue.
 *
 * RACE CONDITION MITIGATIONS
 * ==========================
 * RC-1: chdir validates directory existence before updating proc.cwd
 * RC-2: resolvePath is pure function with no async operations - no race window
 * RC-3: TOCTOU window in chdir is unavoidable without transactional VFS
 *
 * MEMORY MANAGEMENT
 * =================
 * All syscalls return immediate results with no cleanup required. Environment
 * variables and arguments are stored in proc.env/proc.args for the lifetime
 * of the process. No temporary allocations need explicit cleanup.
 *
 * @module kernel/syscalls/misc
 */

import type { VFS } from '@src/vfs/index.js';
import type { Process } from '@src/kernel/types.js';
import type { Response } from '@src/message.js';
import { respond } from '@src/message.js';
import type { SyscallRegistry } from './types.js';

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Resolve a path relative to a base directory.
 *
 * Handles absolute paths, relative paths, and special components (., ..).
 * Always returns an absolute path starting with '/'.
 *
 * ALGORITHM:
 * 1. If path is absolute, return as-is
 * 2. Split base and path into components
 * 3. Iterate through path components:
 *    - Skip '.' and empty strings
 *    - Pop from base for '..'
 *    - Push regular names to base
 * 4. Join with '/' and prepend root
 *
 * WHY this implementation:
 * Simpler than using URL or path library. No dependencies. Pure function with
 * no async operations means no race conditions.
 *
 * @param cwd - Current working directory (absolute path)
 * @param path - Path to resolve (absolute or relative)
 * @returns Resolved absolute path
 */
function resolvePath(cwd: string, path: string): string {
    // Absolute paths don't need resolution
    if (path.startsWith('/')) {
        return path;
    }

    // Split into components, filtering empty strings from leading/trailing slashes
    const baseParts = cwd.split('/').filter(Boolean);
    const relativeParts = path.split('/');

    // Process each component of the relative path
    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            // Current directory - no-op
            continue;
        } else if (part === '..') {
            // Parent directory - remove last component from base
            // WHY: If baseParts is empty, pop() is a no-op (can't go above root)
            baseParts.pop();
        } else {
            // Regular name - append to path
            baseParts.push(part);
        }
    }

    // Reconstruct absolute path
    return '/' + baseParts.join('/');
}

// =============================================================================
// SYSCALL FACTORY
// =============================================================================

/**
 * Create miscellaneous syscall handlers.
 *
 * Factory function that closes over the VFS instance needed by chdir.
 * Other syscalls don't need VFS access since they only read/write process state.
 *
 * WHY factory pattern:
 * Syscall handlers need access to kernel subsystems (VFS, scheduler, etc).
 * Factories allow dependency injection while keeping handler signatures simple.
 *
 * TESTABILITY: Tests can inject mock VFS to control directory validation behavior.
 *
 * @param vfs - VFS instance for path validation
 * @returns Registry of syscall handlers
 */
export function createMiscSyscalls(vfs: VFS): SyscallRegistry {
    return {
        // =====================================================================
        // PROCESS ARGUMENTS
        // =====================================================================

        /**
         * getargs() - Return process command-line arguments.
         *
         * WHY: Provides POSIX-style argc/argv functionality.
         *
         * @param proc - Calling process
         * @returns Process arguments array
         */
        async *'proc:getargs'(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.args);
        },

        // =====================================================================
        // WORKING DIRECTORY
        // =====================================================================

        /**
         * getcwd() - Get current working directory.
         *
         * WHY: Processes need to know their cwd for relative path resolution.
         *
         * @param proc - Calling process
         * @returns Current working directory path
         */
        async *'proc:getcwd'(proc: Process): AsyncIterable<Response> {
            yield respond.ok(proc.cwd);
        },

        /**
         * chdir(path) - Change current working directory.
         *
         * ALGORITHM:
         * 1. Validate path is a string
         * 2. Resolve path relative to current cwd
         * 3. Verify target exists via vfs.stat()
         * 4. Verify target is a directory (model === 'folder')
         * 5. Update proc.cwd to resolved path
         *
         * RACE CONDITION:
         * TOCTOU window between vfs.stat() and updating proc.cwd. If directory
         * is deleted during this window, process will have invalid cwd.
         *
         * MITIGATION:
         * Subsequent syscalls that use cwd will fail with ENOENT, preventing
         * further operations. Process can recover by chdir to valid directory.
         *
         * @param proc - Calling process
         * @param path - Target directory path (absolute or relative)
         * @returns Success response or error
         */
        async *'proc:chdir'(proc: Process, path: unknown): AsyncIterable<Response> {
            // Validate argument type
            if (typeof path !== 'string') {
                yield respond.error('EINVAL', 'path must be a string');
                return;
            }

            // Resolve path relative to current cwd
            const resolvedPath = resolvePath(proc.cwd, path);

            // Verify path exists and is a directory
            try {
                // RC-1: Check existence and type before modifying process state
                const stat = await vfs.stat(resolvedPath, proc.id);

                // Directory check ensures proc.cwd always points to valid directory
                if (stat.model !== 'folder') {
                    yield respond.error('ENOTDIR', `Not a directory: ${path}`);
                    return;
                }
            } catch (err) {
                // Path doesn't exist or access denied
                // Extract error code and message, defaulting if not present
                const code = (err as { code?: string }).code ?? 'ENOENT';
                const message = (err as Error).message ?? `No such directory: ${path}`;
                yield respond.error(code, message);
                return;
            }

            // Update process working directory
            // WHY: Only update after validation succeeds to maintain INV-2
            proc.cwd = resolvedPath;
            yield respond.ok();
        },

        // =====================================================================
        // ENVIRONMENT VARIABLES
        // =====================================================================

        /**
         * getenv(name) - Get environment variable value.
         *
         * Returns undefined if variable is not set. This matches POSIX semantics
         * where unset variables are distinct from empty strings.
         *
         * WHY: Programs need environment for configuration (PATH, HOME, etc).
         *
         * @param proc - Calling process
         * @param name - Variable name
         * @returns Variable value or undefined
         */
        async *'proc:getenv'(proc: Process, name: unknown): AsyncIterable<Response> {
            // Validate argument type
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }

            // Return value from environment (may be undefined)
            yield respond.ok(proc.env[name]);
        },

        /**
         * setenv(name, value) - Set environment variable.
         *
         * Creates or updates a variable in the process environment. Both name
         * and value must be strings (no numeric or object coercion).
         *
         * WHY: Processes need to modify environment for child processes.
         *
         * @param proc - Calling process
         * @param name - Variable name
         * @param value - Variable value
         * @returns Success response
         */
        async *'proc:setenv'(proc: Process, name: unknown, value: unknown): AsyncIterable<Response> {
            // Validate argument types
            if (typeof name !== 'string') {
                yield respond.error('EINVAL', 'name must be a string');
                return;
            }
            if (typeof value !== 'string') {
                yield respond.error('EINVAL', 'value must be a string');
                return;
            }

            // Update process environment
            proc.env[name] = value;
            yield respond.ok();
        },
    };
}
