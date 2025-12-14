# Process Spawn Performance Tests - Planning

**Status**: Pending reimplementation  
**Original Location**: `perf/kernel/process-spawn.perf.ts` (archived)  
**Reason for Archive**: Tests use outdated kernel.boot() API that accepted init process configuration. New API requires separate init()/boot() calls.

## Test Intentions

These tests validate process lifecycle correctness under high-volume conditions. Focus is on **correctness of spawn/exit**, not timing.

### 1. Sequential Boot Cycles

**Purpose**: Validate kernel can boot/shutdown repeatedly without degradation

- ✓ Complete 10 boot/shutdown cycles successfully
- ✓ Complete 50 boot/shutdown cycles successfully
- Init process should exit cleanly each cycle
- Use `/bin/true.ts` as init program

**Success Criteria**:
- All cycles complete without errors
- No process table leaks between cycles
- Exit codes consistent

---

### 2. Child Processes via Shell

**Purpose**: Validate process spawning via shell command execution (requires `/bin/shell.ts`)

- ✓ Spawn 5 sequential child processes via `echo 1 && echo 2 && ... && echo 5`
- ✓ Spawn 10 sequential child processes
- ✓ Spawn 20 sequential child processes

**Blocked By**: `/bin/shell.ts` implementation

**Success Criteria**:
- Init process exits cleanly
- All child processes complete
- Exit codes correct

---

### 3. Rapid Exit Codes

**Purpose**: Validate kernel correctly reports process exit codes

- ✓ Report exit code 0 from `/bin/true.ts`
- ✓ Report exit code 1 from `/bin/false.ts`
- ✓ Alternate 10 cycles between true/false, verify alternating exit codes [0,1,0,1,...]

**Success Criteria**:
- Exit codes match expected values
- No corruption of exit status across multiple boot cycles

---

### 4. Pipe Chains

**Purpose**: Validate process piping through multiple commands (tests CAT_LOOP bug fix)

**Blocked By**: `/bin/shell.ts` implementation

#### Short Pipes
- ✓ Pipe through 3 cats (echo hello | cat | cat | cat)
- ✓ Pipe through 5 cats
- ✓ Pipe through 10 cats

#### Large Data Pipes
- ✓ Pipe 100-char string through 5 cats
- ✓ Pipe 1000-char string through 5 cats
- ✓ Pipe 10 lines through 5 cats

#### File Pipes
- ✓ Create file, pipe through 5 cats

**Success Criteria**:
- Data flows correctly through all pipes
- No deadlocks in long chains
- Init process exits cleanly

---

### 5. Process Table Cleanup After Exit

**Purpose**: Validate process table doesn't leak processes after exit/shutdown

- ✓ Process table is empty after init exits and shutdown
- ✓ Complete 20 sequential boot cycles without leaking processes

**Success Criteria**:
- Process table size = 0 after each shutdown
- No process resource leaks detected
- Memory/handle cleanup is complete

---

## Reimplementation Notes

### API Changes Required

Old API:
```typescript
await kernel.boot({
    initPath: '/bin/true.ts',
    initArgs: ['true'],
    env: {},
});
```

New API:
```typescript
// If needed: configure kernel before boot
await kernel.init();

// Boot without init process args
await kernel.boot();

// To run init process, use syscall API or spawn separately
```

### Test Harness Changes

- Update to use new kernel.init()/boot() lifecycle
- Consider if init process arguments should be passed via environment or other mechanism
- May need `/bin/shell.ts` implementation first (blocks 4 test groups)

### Helper Functions to Preserve

```typescript
// Wait for init process to exit (become zombie)
async function waitForInitExit(kernel: Kernel, timeout = 5000): Promise<boolean> {
    return await poll(() => {
        const init = kernel.getProcessTable().getInit();
        return !init || init.state === 'zombie';
    }, { timeout });
}
```

---

## Priority

1. **High**: Sequential boot cycles, exit codes, process table cleanup
2. **Medium**: Pipe chains (once shell.ts exists)
3. **Nice-to-have**: Child processes via shell (depends on shell.ts)
