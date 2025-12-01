/**
 * Spawn and Wait Integration Tests
 *
 * Tests process creation and lifecycle:
 * - Parent spawns child
 * - Child runs and exits
 * - Parent waits and gets exit status
 */

import { describe, it } from 'bun:test';

// TODO: Create proper test fixtures for spawn integration tests
// Requires: rom/bin/test-parent.ts, rom/bin/test-child.ts
describe.skip('Spawn and Wait', () => {
    it.skip('should spawn child and wait for exit', () => {});
    it.skip('should report correct exit code from child', () => {});
    it.skip('should handle child that exits with 0', () => {});
    it.skip('should assign correct PIDs', () => {});
    it.skip('should track multiple children in process table', () => {});
});

describe.skip('Spawn Errors', () => {
    it.skip('should handle spawn of non-existent file', () => {});
});
