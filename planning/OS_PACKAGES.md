# Monk OS Package Management

## Philosophy

**Install ≠ Activate**

Package installation and activation are separate operations. Installing a package copies files to disk. Activating a package makes it available to the system. This separation enables:

- Atomic version switching (flip a map entry, instant change)
- Safe rollback (point to previous version)
- Parallel installation (download while system runs)
- No partial states (old version or new, never half-installed)
- Test before activate (run tests against new version, then switch)

## Architecture

### Directory Structure

```
/pkg/                              # Package storage (FileModel)
├── nginx/
│   ├── .git/                      # Bare git repo (shared objects)
│   ├── v1.24.0/                   # Worktree at tag v1.24.0
│   │   ├── bin/nginx
│   │   └── etc/nginx.conf
│   ├── v1.25.0/                   # Worktree at tag v1.25.0
│   │   └── ...
│   └── stable/                    # Worktree tracking 'stable' branch
│       └── ...
├── redis/
│   ├── .git/
│   └── v7.0.0/
└── .active                        # Version map (JSON)
    { "nginx": "v1.24.0", "redis": "v7.0.0" }

/usr/                              # PackageMount → resolves via .active
├── nginx/                         # Virtual, maps to /pkg/nginx/v1.24.0
│   ├── bin/nginx
│   └── etc/nginx.conf
└── redis/
    └── ...
```

### PackageMount

A single VFS mount handles all package resolution:

```typescript
interface PackageModel extends Model {
    name: 'package';
    root: string;                        // '/pkg'
    versions: Map<string, string>;       // nginx → 'v1.24.0'
}

class PackageModel implements Model {
    async resolve(subpath: string): Promise<string> {
        // subpath = '/nginx/bin/nginx'
        const [, pkg, ...rest] = subpath.split('/');

        const version = this.versions.get(pkg);
        if (!version) throw new Error('ENOENT: package not activated');

        // Resolve to versioned worktree
        return `${this.root}/${pkg}/${version}/${rest.join('/')}`;
        // → '/pkg/nginx/v1.24.0/bin/nginx'
    }

    async list(subpath: string): Promise<string[]> {
        if (subpath === '/') {
            return [...this.versions.keys()];  // Activated packages
        }
        const realPath = await this.resolve(subpath);
        return this.vfs.readdir(realPath);
    }
}
```

**Mount setup:**

```typescript
const pkgModel = new PackageModel(vfs, '/pkg');
vfs.mount('/usr', { type: 'model', model: pkgModel });
```

### Git as Transport Layer

Git provides package transport, storage, and versioning:

| Operation | Git Command |
|-----------|-------------|
| Add package source | `git clone --bare <url> /pkg/<name>/.git` |
| Update available versions | `git fetch` |
| Install version | `git worktree add /pkg/<name>/<ref> <ref>` |
| List versions | `git tag -l` |
| Diff versions | `git diff v1.24.0..v1.25.0` |
| Verify signatures | `git verify-tag <tag>` |
| Remove version | `git worktree remove /pkg/<name>/<ref>` |

**Worktree benefits:**

- Shared `.git/objects` across all versions (storage efficient)
- Incremental fetch (only new objects downloaded)
- Each worktree is a complete, independent file tree
- Branch-tracking worktrees can `git pull` for updates

---

## Package Manager Operations

### Core Commands

```typescript
const pkg = {
    // Add a new package source
    add: async (name: string, url: string): Promise<void> => {
        await git.clone(url, `/pkg/${name}`, { bare: true });
    },

    // Fetch latest tags/branches from remote
    update: async (name: string): Promise<void> => {
        await git.fetch(`/pkg/${name}`);
    },

    // Create worktree for specific version
    install: async (name: string, ref: string): Promise<void> => {
        await git.worktree.add(`/pkg/${name}`, `/pkg/${name}/${ref}`, ref);
    },

    // Set active version (just updates the map)
    activate: async (name: string, ref: string): Promise<void> => {
        versions.set(name, ref);
        await persist();
    },

    // Remove a version worktree
    remove: async (name: string, ref: string): Promise<void> => {
        if (versions.get(name) === ref) {
            throw new Error('Cannot remove active version');
        }
        await git.worktree.remove(`/pkg/${name}/${ref}`);
    },

    // Remove non-active versions
    gc: async (): Promise<void> => {
        for (const name of await readdir('/pkg')) {
            const active = versions.get(name);
            for (const ref of await readdir(`/pkg/${name}`)) {
                if (ref !== '.git' && ref !== active) {
                    await git.worktree.remove(`/pkg/${name}/${ref}`);
                }
            }
        }
    },
};
```

### Workflow Example

```bash
# Add nginx package source
pkg add nginx https://packages.monk.dev/nginx.git

# See available versions
pkg list nginx
# v1.24.0, v1.25.0, stable, beta

# Install and activate a version
pkg install nginx v1.24.0
pkg activate nginx v1.24.0

# Later: check for updates
pkg update nginx
# New version v1.26.0 available

# Install new version (doesn't affect running system)
pkg install nginx v1.26.0

# Test new version directly
/pkg/nginx/v1.26.0/bin/nginx -t

# Activate new version (atomic switch)
pkg activate nginx v1.26.0

# Problem? Instant rollback
pkg activate nginx v1.24.0

# Clean up old versions
pkg gc
```

### Branch Tracking

Packages can track branches for rolling updates:

```typescript
// Install branch-tracking worktree
await pkg.install('nginx', 'stable');
await pkg.activate('nginx', 'stable');

// Update to latest on branch
async updateBranch(name: string, branch: string): Promise<void> {
    await git.fetch(`/pkg/${name}`);
    const cwd = `/pkg/${name}/${branch}`;
    await git.pull(cwd);  // Pull in worktree
}
```

---

## Running Process Behavior

File descriptors resolve at `open()` time. Version changes don't affect running processes:

```
Process A: opens /usr/nginx/bin/nginx
         → resolves to /pkg/nginx/v1.24.0/bin/nginx
         → fd 5 points to this file

Admin: pkg activate nginx v1.25.0

Process A: fd 5 still reads v1.24.0 (already resolved)
Process B: opens /usr/nginx/bin/nginx
         → resolves to /pkg/nginx/v1.25.0/bin/nginx (new version)
```

Clean semantics: existing processes unaffected, new processes get new version.

---

## Comparison with Other Systems

| Aspect | Debian | Homebrew | Nix | Monk |
|--------|--------|----------|-----|------|
| Install location | `/usr/*` scattered | `/opt/homebrew/Cellar` | `/nix/store/<hash>` | `/pkg/<name>/<version>` |
| Multiple versions | No | Yes (kegs) | Yes (paths) | Yes (worktrees) |
| Activation | Immediate | Symlinks | Profile symlinks | Version map |
| Shared storage | System libs | Cellar dedup | Store dedup | Git objects |
| Rollback | Difficult | `brew switch` | Generations | Map flip |
| Update transport | HTTP + deb | Git (formulas) + bottles | Nix expressions | Git fetch |
| Atomic switch | No | No | Yes | Yes |

### Key Differentiators

**vs Debian:** Monk separates install from activate. Debian's `dpkg` immediately makes packages active. Monk can install without disruption.

**vs Homebrew:** Similar Cellar/version structure, but Monk uses git worktrees (shared objects) instead of separate downloads. Activation is map-based, not symlink-based.

**vs Nix:** Similar atomic activation semantics. Monk skips content-addressing (simpler paths) but loses guaranteed reproducibility. Git provides versioning instead of hashes.

---

## Registry

Package sources are git remotes:

```typescript
// /etc/pkg/sources.json
{
    "origin": "https://packages.monk.dev",
    "community": "https://github.com/monk-packages"
}
```

A registry is just a git hosting service. Supports:

- Self-hosted (local bare repos for air-gapped systems)
- GitHub/GitLab
- Dedicated package server

---

## Binary Path Handling

Two options for `/bin`:

### Option A: $PATH (recommended)

Shell `$PATH` includes package binary directories:

```bash
PATH=/usr/nginx/bin:/usr/redis/bin:/usr/node/bin
```

No special `/bin` mount needed. Standard Unix semantics.

### Option B: BinMount

Flattening mount that aggregates `*/bin/*`:

```typescript
vfs.mount('/bin', BinMount({ source: '/usr' }));

// /bin/nginx → scans /usr/*/bin/nginx, returns first match
```

More convenient but adds complexity.

---

## Persistence

### Version Map

```typescript
// /pkg/.active (JSON file)
{
    "nginx": "v1.24.0",
    "redis": "v7.0.0",
    "node": "stable"
}
```

Loaded by PackageModel on boot, updated on `activate()`.

### Package Sources

```typescript
// /etc/pkg/packages.json
{
    "nginx": "https://packages.monk.dev/nginx.git",
    "redis": "https://packages.monk.dev/redis.git"
}
```

Used by `pkg add` and `pkg update --all`.

---

## Implementation Plan

### Phase 1: Core Structure

1. Create `/pkg` directory structure
2. Implement PackageModel with version map
3. Mount PackageModel at `/usr`
4. Implement version map persistence

### Phase 2: Git Integration

1. Add git operations to HAL HostDevice (or shell out)
2. Implement `pkg add` (clone bare repo)
3. Implement `pkg install` (worktree add)
4. Implement `pkg update` (fetch)

### Phase 3: Package Manager

1. Implement `pkg activate` (map update)
2. Implement `pkg remove` (worktree remove)
3. Implement `pkg gc` (clean inactive)
4. Implement `pkg list` (show status)

### Phase 4: Polish

1. Branch tracking and updates
2. Signature verification
3. Dependency resolution (optional)
4. Lock files for reproducible environments

---

## Source Files

- PackageModel: `src/vfs/models/package.ts`
- Package Manager: `src/pkg/manager.ts`
- CLI commands: `src/bin/pkg.ts`

## Tests

- `spec/vfs/package.test.ts`
- `spec/pkg/manager.test.ts`
