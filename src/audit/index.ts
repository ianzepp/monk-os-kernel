/**
 * Audit Subsystem
 *
 * Optional change tracking for fields marked with tracked=1.
 *
 * USAGE
 * =====
 * ```typescript
 * import { Audit } from '@src/audit/index.js';
 *
 * // After EMS is initialized
 * const audit = new Audit(hal, ems);
 * await audit.init();
 *
 * // Now changes to tracked fields will be recorded
 * ```
 *
 * ARCHITECTURE
 * ============
 * The audit subsystem provides:
 * 1. The `tracked` table for storing change history
 * 2. The `Tracked` observer (Ring 7) that records changes
 *
 * The `tracked` field flag in the fields table is part of EMS core.
 * This subsystem provides the infrastructure to act on that flag.
 *
 * @module audit
 */

import type { HAL } from '@src/hal/index.js';
import type { EMS } from '@src/ems/ems.js';
import { Tracked } from '@src/ems/ring/7/60-tracked.js';

// Re-export the observer for direct access
export { Tracked } from '@src/ems/ring/7/60-tracked.js';

/**
 * Audit subsystem for change tracking.
 */
export class Audit {
    private readonly hal: HAL;
    private readonly ems: EMS;
    private initialized = false;

    constructor(hal: HAL, ems: EMS) {
        this.hal = hal;
        this.ems = ems;
    }

    /**
     * Initialize the audit subsystem.
     *
     * 1. Loads the audit schema (creates tracked table)
     * 2. Registers the Tracked observer in the EMS pipeline
     */
    async init(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Load audit schema
        const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
        const schema = await this.hal.file.readText(schemaPath);

        await this.ems.exec(schema, { clearModels: true });

        // Register the Tracked observer
        this.ems.runner.register(new Tracked());

        this.initialized = true;
    }

    /**
     * Check if audit is initialized.
     */
    isInitialized(): boolean {
        return this.initialized;
    }
}
