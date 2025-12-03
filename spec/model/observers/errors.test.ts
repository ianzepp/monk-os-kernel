import { describe, it, expect } from 'bun:test';
import {
    ObserverError,
    EOBSINVALID,
    EOBSFROZEN,
    EOBSIMMUT,
    EOBSSEC,
    EOBSBUS,
    EOBSSYS,
    EOBSTIMEOUT,
    EOBSERVER,
    isObserverError,
    isValidationError,
    hasErrorCode,
} from '@src/model/observers/index.js';

describe('Observer Errors', () => {
    describe('ObserverError base class', () => {
        it('should have correct code and errno', () => {
            const err = new ObserverError('TEST', 9999, 'test message');
            expect(err.code).toBe('TEST');
            expect(err.errno).toBe(9999);
            expect(err.message).toBe('test message');
            expect(err.name).toBe('ObserverError');
        });

        it('should be instanceof Error', () => {
            const err = new ObserverError('TEST', 9999, 'test');
            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(ObserverError);
        });
    });

    describe('EOBSINVALID', () => {
        it('should have correct code 1001', () => {
            const err = new EOBSINVALID();
            expect(err.code).toBe('EOBSINVALID');
            expect(err.errno).toBe(1001);
            expect(err.name).toBe('EOBSINVALID');
            expect(err.message).toBe('Validation failed');
        });

        it('should accept custom message', () => {
            const err = new EOBSINVALID('Name is required');
            expect(err.message).toBe('Name is required');
        });

        it('should accept field parameter', () => {
            const err = new EOBSINVALID('Name is required', 'name');
            expect(err.field).toBe('name');
        });

        it('should have undefined field by default', () => {
            const err = new EOBSINVALID();
            expect(err.field).toBeUndefined();
        });
    });

    describe('EOBSFROZEN', () => {
        it('should have correct code 1002', () => {
            const err = new EOBSFROZEN();
            expect(err.code).toBe('EOBSFROZEN');
            expect(err.errno).toBe(1002);
            expect(err.name).toBe('EOBSFROZEN');
            expect(err.message).toBe('Model is frozen');
        });

        it('should accept custom message', () => {
            const err = new EOBSFROZEN("Model 'users' is frozen");
            expect(err.message).toBe("Model 'users' is frozen");
        });
    });

    describe('EOBSIMMUT', () => {
        it('should have correct code 1003', () => {
            const err = new EOBSIMMUT();
            expect(err.code).toBe('EOBSIMMUT');
            expect(err.errno).toBe(1003);
            expect(err.name).toBe('EOBSIMMUT');
            expect(err.message).toBe('Field is immutable');
        });

        it('should accept field parameter', () => {
            const err = new EOBSIMMUT('Cannot change created_at', 'created_at');
            expect(err.field).toBe('created_at');
            expect(err.message).toBe('Cannot change created_at');
        });
    });

    describe('EOBSSEC', () => {
        it('should have correct code 1010', () => {
            const err = new EOBSSEC();
            expect(err.code).toBe('EOBSSEC');
            expect(err.errno).toBe(1010);
            expect(err.name).toBe('EOBSSEC');
            expect(err.message).toBe('Security violation');
        });

        it('should accept custom message', () => {
            const err = new EOBSSEC('Sudo required for model operations');
            expect(err.message).toBe('Sudo required for model operations');
        });
    });

    describe('EOBSBUS', () => {
        it('should have correct code 1020', () => {
            const err = new EOBSBUS();
            expect(err.code).toBe('EOBSBUS');
            expect(err.errno).toBe(1020);
            expect(err.name).toBe('EOBSBUS');
            expect(err.message).toBe('Business rule violation');
        });

        it('should accept custom message', () => {
            const err = new EOBSBUS('Insufficient balance');
            expect(err.message).toBe('Insufficient balance');
        });
    });

    describe('EOBSSYS', () => {
        it('should have correct code 1030', () => {
            const err = new EOBSSYS();
            expect(err.code).toBe('EOBSSYS');
            expect(err.errno).toBe(1030);
            expect(err.name).toBe('EOBSSYS');
            expect(err.message).toBe('System error');
        });

        it('should accept custom message', () => {
            const err = new EOBSSYS('Database connection lost');
            expect(err.message).toBe('Database connection lost');
        });
    });

    describe('EOBSTIMEOUT', () => {
        it('should have correct code 1031', () => {
            const err = new EOBSTIMEOUT();
            expect(err.code).toBe('EOBSTIMEOUT');
            expect(err.errno).toBe(1031);
            expect(err.name).toBe('EOBSTIMEOUT');
            expect(err.message).toBe('Observer timed out');
        });

        it('should accept custom message', () => {
            const err = new EOBSTIMEOUT('DataValidator timed out after 5000ms');
            expect(err.message).toBe('DataValidator timed out after 5000ms');
        });
    });

    describe('EOBSERVER', () => {
        it('should have correct code 1032', () => {
            const err = new EOBSERVER();
            expect(err.code).toBe('EOBSERVER');
            expect(err.errno).toBe(1032);
            expect(err.name).toBe('EOBSERVER');
            expect(err.message).toBe('Observer failed');
        });

        it('should accept custom message', () => {
            const err = new EOBSERVER('Unknown error in SqlCreate');
            expect(err.message).toBe('Unknown error in SqlCreate');
        });
    });

    describe('isObserverError', () => {
        it('should return true for ObserverError instances', () => {
            expect(isObserverError(new ObserverError('TEST', 1, 'test'))).toBe(true);
            expect(isObserverError(new EOBSINVALID())).toBe(true);
            expect(isObserverError(new EOBSFROZEN())).toBe(true);
            expect(isObserverError(new EOBSIMMUT())).toBe(true);
            expect(isObserverError(new EOBSSEC())).toBe(true);
            expect(isObserverError(new EOBSBUS())).toBe(true);
            expect(isObserverError(new EOBSSYS())).toBe(true);
            expect(isObserverError(new EOBSTIMEOUT())).toBe(true);
            expect(isObserverError(new EOBSERVER())).toBe(true);
        });

        it('should return false for non-ObserverError values', () => {
            expect(isObserverError(new Error('test'))).toBe(false);
            expect(isObserverError(null)).toBe(false);
            expect(isObserverError(undefined)).toBe(false);
            expect(isObserverError('EOBSINVALID')).toBe(false);
            expect(isObserverError({ code: 'EOBSINVALID' })).toBe(false);
        });
    });

    describe('isValidationError', () => {
        it('should return true for EOBSINVALID instances', () => {
            expect(isValidationError(new EOBSINVALID())).toBe(true);
            expect(isValidationError(new EOBSINVALID('test', 'field'))).toBe(true);
        });

        it('should return false for other ObserverError types', () => {
            expect(isValidationError(new EOBSFROZEN())).toBe(false);
            expect(isValidationError(new EOBSIMMUT())).toBe(false);
            expect(isValidationError(new EOBSSEC())).toBe(false);
        });

        it('should return false for non-errors', () => {
            expect(isValidationError(new Error('test'))).toBe(false);
            expect(isValidationError(null)).toBe(false);
        });
    });

    describe('hasErrorCode', () => {
        it('should return true when error has matching code', () => {
            expect(hasErrorCode(new EOBSINVALID(), 'EOBSINVALID')).toBe(true);
            expect(hasErrorCode(new EOBSFROZEN(), 'EOBSFROZEN')).toBe(true);
            expect(hasErrorCode(new EOBSSEC(), 'EOBSSEC')).toBe(true);
        });

        it('should return false when error has different code', () => {
            expect(hasErrorCode(new EOBSINVALID(), 'EOBSFROZEN')).toBe(false);
            expect(hasErrorCode(new EOBSFROZEN(), 'EOBSINVALID')).toBe(false);
        });

        it('should return false for non-ObserverError', () => {
            expect(hasErrorCode(new Error('test'), 'EOBSINVALID')).toBe(false);
            expect(hasErrorCode(null, 'EOBSINVALID')).toBe(false);
        });
    });

    describe('errno uniqueness', () => {
        it('all error types should have unique errno values', () => {
            const errors = [
                new EOBSINVALID(),
                new EOBSFROZEN(),
                new EOBSIMMUT(),
                new EOBSSEC(),
                new EOBSBUS(),
                new EOBSSYS(),
                new EOBSTIMEOUT(),
                new EOBSERVER(),
            ];

            const errnos = errors.map((e) => e.errno);
            const uniqueErrnos = new Set(errnos);
            expect(uniqueErrnos.size).toBe(errors.length);
        });

        it('all errno values should be >= 1000', () => {
            const errors = [
                new EOBSINVALID(),
                new EOBSFROZEN(),
                new EOBSIMMUT(),
                new EOBSSEC(),
                new EOBSBUS(),
                new EOBSSYS(),
                new EOBSTIMEOUT(),
                new EOBSERVER(),
            ];

            for (const err of errors) {
                expect(err.errno).toBeGreaterThanOrEqual(1000);
            }
        });
    });
});
