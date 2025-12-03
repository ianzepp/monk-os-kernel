/**
 * Process Table
 *
 * Manages the collection of running processes.
 * Provides lookup by UUID and maintains parent-child relationships.
 */

import type { Process } from '@src/kernel/types.js';

/**
 * Process table for managing running processes
 */
export class ProcessTable {
    /** Processes by UUID */
    private processes: Map<string, Process> = new Map();

    /** Init process reference */
    private initProcess: Process | null = null;

    /**
     * Register a process in the table.
     *
     * @param proc - Process to register
     * @param asInit - If true, explicitly set this as the init process
     */
    register(proc: Process, asInit = false): void {
        this.processes.set(proc.id, proc);

        // Explicit init registration takes precedence
        if (asInit) {
            this.initProcess = proc;
        }
    }

    /**
     * Remove a process from the table.
     */
    unregister(id: string): void {
        this.processes.delete(id);
    }

    /**
     * Get a process by UUID.
     */
    get(id: string): Process | undefined {
        return this.processes.get(id);
    }

    /**
     * Get the init process.
     */
    getInit(): Process | null {
        return this.initProcess;
    }

    /**
     * Check if a process exists.
     */
    has(id: string): boolean {
        return this.processes.has(id);
    }

    /**
     * Get all processes.
     */
    all(): IterableIterator<Process> {
        return this.processes.values();
    }

    /**
     * Get process count.
     */
    get size(): number {
        return this.processes.size;
    }

    /**
     * Find children of a process.
     */
    getChildren(parentId: string): Process[] {
        const children: Process[] = [];
        for (const proc of this.processes.values()) {
            if (proc.parent === parentId) {
                children.push(proc);
            }
        }
        return children;
    }

    /**
     * Resolve a PID to process UUID within a parent's context.
     *
     * PIDs are local to a parent process. The parent's children
     * map tracks which PIDs map to which process UUIDs.
     */
    resolvePid(parent: Process, pid: number): Process | undefined {
        const childId = parent.children.get(pid);
        if (!childId) {
            return undefined;
        }
        return this.processes.get(childId);
    }

    /**
     * Find processes in zombie state.
     */
    getZombies(): Process[] {
        const zombies: Process[] = [];
        for (const proc of this.processes.values()) {
            if (proc.state === 'zombie') {
                zombies.push(proc);
            }
        }
        return zombies;
    }

    /**
     * Reparent orphaned processes to init.
     *
     * Called when a process exits to reparent its children.
     */
    reparentOrphans(deadParentId: string): void {
        if (!this.initProcess) return;

        for (const proc of this.processes.values()) {
            if (proc.parent === deadParentId && proc.id !== this.initProcess.id) {
                proc.parent = this.initProcess.id;
                // Assign a new PID in init's namespace
                const newPid = this.initProcess.nextPid++;
                this.initProcess.children.set(newPid, proc.id);
            }
        }
    }

    /**
     * Clear all processes (for shutdown).
     */
    clear(): void {
        this.processes.clear();
        this.initProcess = null;
    }
}
