/**
 * Channel Handle Unwrapping - Extract Channel from handle
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * Extracts the underlying Channel object from a handle, verifying type safety.
 * Used by channel syscalls (HTTP, WebSocket, PostgreSQL) to access the
 * protocol-specific interface.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: If handle exists and type='channel', getChannel() returns Channel
 *        VIOLATED BY: ChannelHandleAdapter without valid channel
 * INV-2: Type check prevents access to wrong handle types
 *        VIOLATED BY: Skipping type check, casting blindly
 * INV-3: Returns undefined for non-channel handles (not error)
 *        VIOLATED BY: Throwing exception instead of undefined
 *
 * CONCURRENCY MODEL
 * =================
 * Single-threaded: All handle operations run in main kernel thread.
 * No async points, no race conditions.
 *
 * TYPE SAFETY
 * ===========
 * Handle system is polymorphic: Multiple handle types (file, socket, pipe,
 * port, channel) share the same fd namespace. Type checks ensure we only
 * extract channels from channel handles.
 *
 * WHY return undefined instead of throwing:
 * Allows syscalls to distinguish "fd doesn't exist" from "fd is wrong type".
 * Caller can return appropriate error (EBADF vs EINVAL).
 *
 * @module kernel/kernel/get-channel-from-handle
 */

import type { Kernel } from '../kernel.js';
import type { Process } from '../types.js';
import type { Channel } from '../../hal/index.js';
import { ChannelHandleAdapter } from '../handle.js';
import { getHandle } from './get-handle.js';

/**
 * Get a channel from a handle.
 *
 * ALGORITHM:
 * 1. Lookup handle by fd (using getHandle)
 * 2. Check if handle exists and type is 'channel'
 * 3. Cast to ChannelHandleAdapter and extract channel
 * 4. Return channel or undefined
 *
 * WHY type check is critical:
 * Prevents accessing channel-specific methods on file/socket handles.
 * Without this, syscalls would crash or corrupt memory.
 *
 * HANDLE TYPE HIERARCHY:
 * All handles implement: exec(msg) → AsyncIterable<Response>, close()
 * Channel handles additionally provide: getChannel() → Channel
 * Channel interface provides: request(), subscribe(), query(), etc.
 *
 * TYPE CAST SAFETY:
 * TypeScript `as ChannelHandleAdapter` is safe because:
 * 1. We checked handle.type === 'channel' first
 * 2. Only ChannelHandleAdapter instances return type='channel'
 * 3. Cast is for accessing adapter-specific getChannel() method
 *
 * USAGE PATTERN:
 * ```typescript
 * const channel = getChannelFromHandle(kernel, proc, fd);
 * if (!channel) {
 *   throw new EINVAL('File descriptor is not a channel');
 * }
 * // Now safe to call channel-specific methods
 * const response = await channel.request({ method: 'GET', url: '/' });
 * ```
 *
 * @param self - Kernel instance
 * @param proc - Process owning the fd
 * @param h - Handle number (fd) to unwrap
 * @returns Channel object or undefined if not a channel handle
 */
export function getChannelFromHandle(
    self: Kernel,
    proc: Process,
    h: number
): Channel | undefined {
    // Lookup handle (returns undefined if fd doesn't exist)
    const handle = getHandle(self, proc, h);

    // Type check: Ensure handle is a channel
    if (!handle || handle.type !== 'channel') {
        return undefined;
    }

    // Safe cast: We verified type='channel', so this must be ChannelHandleAdapter
    // Extract underlying Channel object from adapter
    return (handle as ChannelHandleAdapter).getChannel();
}
