# KERNEL_ID Constant Refactor

## Problem

The string `'kernel'` is used as a magic string throughout the codebase (~59 occurrences) to represent kernel identity for:
- VFS caller identity (ACL bypass)
- File ownership
- Process identity (kernel process is PID 1)
- Mount policy rules

This should be a named constant for consistency and maintainability.

## Solution

Add a `KERNEL_ID` constant to `src/kernel/types.ts` and replace all magic string usages.

```typescript
// src/kernel/types.ts
export const KERNEL_ID = 'kernel';
```

## Occurrences by Category

| Category | Count | Example |
|----------|-------|---------|
| VFS caller arg | ~40 | `vfs.stat('/path', 'kernel')` |
| Owner constants | 3 | `const PROC_FILE_OWNER = 'kernel'` |
| ACL check | 3 | `if (caller === 'kernel')` |
| Mount policy | 3 | `{ caller: 'kernel', ... }` |
| Kernel process | 3 | `id: 'kernel', user: 'kernel'` |
| Default params | 3 | `caller: string = 'kernel'` |
| Comments | ~4 | Documentation strings |

## Files to Update

```
src/kernel/types.ts          # Add constant
src/kernel/kernel.ts         # Kernel process creation, mount policy
src/kernel/boot.ts           # VFS calls
src/kernel/mounts.ts         # VFS calls, ACL grants
src/kernel/pool.ts           # VFS calls
src/kernel/loader/vfs-loader.ts
src/kernel/kernel/activate-service.ts
src/kernel/kernel/create-io-source-handle.ts
src/kernel/kernel/create-io-target-handle.ts
src/kernel/kernel/load-services.ts
src/kernel/kernel/load-services-from-dir.ts
src/kernel/kernel/setup-service-stdio.ts
src/os/os.ts
src/os/base.ts
src/os/stack.ts
src/vfs/vfs.ts               # ACL check
src/vfs/mounts/proc.ts       # Owner constant, ACL checks, default params
src/vfs/mounts/host.ts       # Owner constant
src/vfs/mounts/entity.ts     # Owner constant
```

## Implementation Steps

1. Add `KERNEL_ID` constant to `src/kernel/types.ts`
2. Export from `src/kernel/index.ts`
3. Run sed replacement:
   ```bash
   # Replace 'kernel' with KERNEL_ID in src/ (excluding comments)
   rg -l "'kernel'" --type ts src/ | xargs sed -i '' "s/'kernel'/KERNEL_ID/g"
   ```
4. Manually add imports to each affected file:
   ```typescript
   import { KERNEL_ID } from '@src/kernel/types.js';
   ```
5. Update owner constants to reference KERNEL_ID:
   ```typescript
   const PROC_FILE_OWNER = KERNEL_ID;
   ```
6. Run typecheck: `bun run typecheck`
7. Run tests: `bun test`

## Notes

- The constant value remains `'kernel'` - this is a refactor, not a behavioral change
- Could later change to nil UUID (`'00000000-0000-0000-0000-000000000000'`) if desired
- Consider also adding `KERNEL_USER` if we want to distinguish process ID from ACL identity (currently same value)

## Priority

Low - cosmetic/maintenance improvement, no functional impact.
