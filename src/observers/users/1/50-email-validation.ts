/**
 * Email Validation Observer
 *
 * Validates email format for user operations
 * Ring: 0 (Validation) - Model: users - Operations: create, update
 */

import type { ObserverContext } from '@src/lib/observers/interfaces.js';
import { BaseObserver } from '@src/lib/observers/base-observer.js';
import { ObserverRing } from '@src/lib/observers/types.js';
import { ValidationError } from '@src/lib/observers/errors.js';
import type { ModelRecord } from '@src/lib/model-record.js';

export default class EmailValidator extends BaseObserver {
    ring = ObserverRing.InputValidation;
    operations = ['create', 'update'] as const;
    models = ['users'] as const;

    async execute(context: ObserverContext): Promise<void> {
        const { record } = context;

        if (!record.email) {
            return; // No email to validate
        }

        if (!this.isValidEmail(record.email)) {
            throw new ValidationError('Invalid email format', 'email');
        }

        // Normalize email to lowercase
        record.email = record.email.toLowerCase().trim();
    }

    private isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return typeof email === 'string' && emailRegex.test(email);
    }
}
