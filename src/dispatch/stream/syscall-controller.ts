/**
 * SyscallController - Backpressure for syscalls (kernel produces, userspace consumes)
 *
 * Wraps kernel-side syscall handlers that produce streaming responses.
 * Userspace consumer sends syscall:ping messages to acknowledge processing.
 *
 * Flow:
 *   Kernel handler ──yield──> SyscallController ──postMessage──> Worker
 *                                    ↑
 *                           syscall:ping (processed count)
 *
 * @module dispatch/stream/syscall-controller
 */

import { StreamController } from './controller.js';

/**
 * Controller for syscall streams (kernel → userspace).
 *
 * Currently identical to StreamController. Separate class allows:
 * - Semantic clarity (syscall vs sigcall direction)
 * - Future customization (different defaults, hooks)
 * - Type safety in dispatcher code
 */
export class SyscallController extends StreamController {}
