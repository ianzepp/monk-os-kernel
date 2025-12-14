/**
 * SigcallController - Backpressure for sigcalls (userspace produces, kernel consumes)
 *
 * Wraps userspace sigcall handlers that produce streaming responses.
 * Kernel (dispatcher) sends sigcall:ping messages to acknowledge processing.
 *
 * Flow:
 *   Worker handler ──postMessage──> Dispatcher ──SigcallController──> caller
 *                                        │
 *                               sigcall:ping (processed count)
 *                                        ↓
 *                                     Worker
 *
 * This is the inverse of SyscallController:
 * - SyscallController: kernel produces, userspace consumes, userspace pings
 * - SigcallController: userspace produces, kernel consumes, kernel pings
 *
 * @module dispatch/stream/sigcall-controller
 */

import { StreamController } from './controller.js';

/**
 * Controller for sigcall streams (userspace → kernel).
 *
 * Currently identical to StreamController. Separate class allows:
 * - Semantic clarity (sigcall vs syscall direction)
 * - Future customization (different defaults, hooks)
 * - Type safety in dispatcher code
 */
export class SigcallController extends StreamController {}
