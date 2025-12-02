/**
 * ProcessTable Tests
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ProcessTable } from '@src/kernel/process-table.js';
import type { Process } from '@src/kernel/types.js';

/**
 * Create a mock process for testing
 */
function createMockProcess(overrides: Partial<Process> = {}): Process {
    return {
        id: crypto.randomUUID(),
        parent: '',
        worker: {} as Worker,
        state: 'running',
        cmd: '/bin/test',
        cwd: '/',
        env: {},
        args: [],
        handles: new Map(),
        nextHandle: 3,
        children: new Map(),
        nextPid: 1,
        activeStreams: new Map(),
        streamPingHandlers: new Map(),
        ...overrides,
    };
}

describe('ProcessTable', () => {
    let table: ProcessTable;

    beforeEach(() => {
        table = new ProcessTable();
    });

    describe('register', () => {
        it('should register a process', () => {
            const proc = createMockProcess();
            table.register(proc);

            expect(table.has(proc.id)).toBe(true);
            expect(table.get(proc.id)).toBe(proc);
        });

        it('should set first registered process as init', () => {
            const init = createMockProcess({ cmd: '/bin/init' });
            const other = createMockProcess({ cmd: '/bin/shell' });

            table.register(init);
            table.register(other);

            expect(table.getInit()).toBe(init);
        });
    });

    describe('unregister', () => {
        it('should remove a process', () => {
            const proc = createMockProcess();
            table.register(proc);
            table.unregister(proc.id);

            expect(table.has(proc.id)).toBe(false);
            expect(table.get(proc.id)).toBeUndefined();
        });
    });

    describe('size', () => {
        it('should return the number of processes', () => {
            expect(table.size).toBe(0);

            table.register(createMockProcess());
            expect(table.size).toBe(1);

            table.register(createMockProcess());
            expect(table.size).toBe(2);
        });
    });

    describe('all', () => {
        it('should iterate all processes', () => {
            const p1 = createMockProcess();
            const p2 = createMockProcess();
            table.register(p1);
            table.register(p2);

            const all = [...table.all()];
            expect(all).toContain(p1);
            expect(all).toContain(p2);
            expect(all.length).toBe(2);
        });
    });

    describe('getChildren', () => {
        it('should find children of a process', () => {
            const parent = createMockProcess();
            const child1 = createMockProcess({ parent: parent.id });
            const child2 = createMockProcess({ parent: parent.id });
            const other = createMockProcess();

            table.register(parent);
            table.register(child1);
            table.register(child2);
            table.register(other);

            const children = table.getChildren(parent.id);
            expect(children).toContain(child1);
            expect(children).toContain(child2);
            expect(children).not.toContain(other);
            expect(children.length).toBe(2);
        });
    });

    describe('resolvePid', () => {
        it('should resolve PID to process', () => {
            const parent = createMockProcess();
            const child = createMockProcess({ parent: parent.id });

            // Register child PID in parent
            parent.children.set(1, child.id);

            table.register(parent);
            table.register(child);

            const resolved = table.resolvePid(parent, 1);
            expect(resolved).toBe(child);
        });

        it('should return undefined for unknown PID', () => {
            const parent = createMockProcess();
            table.register(parent);

            const resolved = table.resolvePid(parent, 999);
            expect(resolved).toBeUndefined();
        });
    });

    describe('getZombies', () => {
        it('should find zombie processes', () => {
            const running = createMockProcess({ state: 'running' });
            const zombie = createMockProcess({ state: 'zombie', exitCode: 0 });

            table.register(running);
            table.register(zombie);

            const zombies = table.getZombies();
            expect(zombies).toContain(zombie);
            expect(zombies).not.toContain(running);
        });
    });

    describe('reparentOrphans', () => {
        it('should reparent children to init when parent dies', () => {
            const init = createMockProcess({ cmd: '/bin/init' });
            const parent = createMockProcess({ parent: init.id });
            const child = createMockProcess({ parent: parent.id });

            // Setup init's children
            init.children.set(1, parent.id);

            table.register(init);
            table.register(parent);
            table.register(child);

            // Parent dies, orphan child
            table.reparentOrphans(parent.id);

            expect(child.parent).toBe(init.id);
            // Child should have a new PID in init's namespace
            expect(init.children.has(init.nextPid - 1)).toBe(true);
        });
    });

    describe('clear', () => {
        it('should remove all processes', () => {
            table.register(createMockProcess());
            table.register(createMockProcess());

            table.clear();

            expect(table.size).toBe(0);
            expect(table.getInit()).toBeNull();
        });
    });
});
