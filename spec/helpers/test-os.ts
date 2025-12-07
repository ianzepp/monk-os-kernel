/**
 * TestOS - OS subclass that exposes internals for testing
 *
 * WHY: Allows tests to access OS internals (HAL, Kernel, Dispatcher, etc.)
 * without polluting the public OS API with test-only methods.
 *
 * NOTE: Property names use "internal" prefix to avoid conflicts with
 * existing OS methods (ems, vfs are already public syscall wrappers).
 *
 * Usage:
 *   const os = new TestOS({ storage: { type: 'memory' } });
 *   await os.boot();
 *   const gateway = new Gateway(os.internalDispatcher, os.internalKernel, os.internalHal);
 */

import { OS } from '@src/os/os.js';
import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/index.js';
import type { VFS } from '@src/vfs/index.js';
import type { Kernel } from '@src/kernel/kernel.js';
import type { SyscallDispatcher } from '@src/syscall/dispatcher.js';
import type { Gateway } from '@src/gateway/gateway.js';

/**
 * Test-only OS subclass that exposes protected internals.
 */
export class TestOS extends OS {
    /**
     * Get the Hardware Abstraction Layer.
     * @throws Error if not booted
     */
    get internalHal(): HAL {
        if (!this.__hal) throw new Error('OS not booted');
        return this.__hal;
    }

    /**
     * Get the Entity Management System.
     * @throws Error if not booted
     */
    get internalEms(): EMS {
        if (!this.__ems) throw new Error('OS not booted');
        return this.__ems;
    }

    /**
     * Get the Virtual File System.
     * @throws Error if not booted
     */
    get internalVfs(): VFS {
        if (!this.__vfs) throw new Error('OS not booted');
        return this.__vfs;
    }

    /**
     * Get the Process Kernel.
     * @throws Error if not booted
     */
    get internalKernel(): Kernel {
        if (!this.__kernel) throw new Error('OS not booted');
        return this.__kernel;
    }

    /**
     * Get the Syscall Dispatcher.
     * @throws Error if not booted
     */
    get internalDispatcher(): SyscallDispatcher {
        if (!this.__dispatcher) throw new Error('OS not booted');
        return this.__dispatcher;
    }

    /**
     * Get the Gateway.
     * @throws Error if not booted
     */
    get internalGateway(): Gateway {
        if (!this.__gateway) throw new Error('OS not booted');
        return this.__gateway;
    }
}
