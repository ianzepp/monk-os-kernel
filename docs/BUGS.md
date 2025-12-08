# Known Bugs

Tracking known issues for future fixes.

---

## Syscall Layer

### Missing `file:setstat` syscall

**Location:** `src/syscall/dispatcher.ts`

VFS has `setstat()` method (`src/vfs/vfs.ts:829`) but the syscall layer doesn't expose it. This means userland can't update file metadata (mtime, custom EMS fields, etc.) via syscall.

**Impact:** Can't implement `touch -m`, can't update EMS entity fields via VFS path.

**Fix:** Add `file:setstat` case to dispatcher, create handler in `src/syscall/vfs.ts`.
