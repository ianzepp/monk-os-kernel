# App Services Design

## Overview

Replace the `rom/app/init.ts` approach with service-based app management. Each app in `/app/{name}/` can define a `service.json` to register as a system service.

## Current State (Problems)

1. `rom/app/init.ts` is designed to spawn all apps, but is never executed
2. `DEFAULT_INIT_PATH = '/app/init.ts'` in os.ts is dead code
3. Apps in `/app/*/main.ts` are never started
4. Model loading is coupled to init.ts

## Proposed Design

### Service Definition

Each app can have `/app/{name}/service.json`:

```json
{
    "handler": "main.ts",
    "activate": "manual",
    "description": "AI assistant daemon",
    "io": {
        "stdin": { "type": "null" },
        "stdout": { "type": "console" },
        "stderr": { "type": "console" }
    }
}
```

### Activation Types

| Type | Behavior |
|------|----------|
| `boot` | Start automatically on `kernel.boot()` |
| `manual` | Only via `os.service('start', 'name')` |
| `tcp:listen` | Socket activation (existing) |
| `udp` | UDP activation (existing) |
| `pubsub` | Topic activation (existing) |
| `watch` | File watch activation (existing) |

**Default for `/app/*`**: `manual` (opt-in to auto-start)

### Handler Resolution

- `"handler": "main.ts"` → resolves to `/app/{name}/main.ts`
- Relative paths resolve from app directory
- Absolute paths work as-is

### Service Discovery

During `kernel.init()`, scan:
1. `/etc/services/*.json` (existing - system services)
2. `/usr/*/etc/services/*.json` (existing - package services)
3. `/app/*/service.json` (new - app services)

Service names:
- `/etc/services/foo.json` → service name: `foo`
- `/app/bar/service.json` → service name: `bar`

### Model Loading

Move model loading out of init.ts. Options:

**A. Per-app responsibility**
Each app loads its own models in main.ts:
```typescript
await call('ems:import', 'myapp.user', userModelDef);
```

**B. Service hook**
Add `models` field to service.json:
```json
{
    "handler": "main.ts",
    "models": ["models/*.json"]
}
```
Kernel loads models before spawning handler.

**C. Schema directory convention**
Kernel scans `/app/{name}/models/*.json` automatically before spawning.

**Recommendation**: Option A (per-app responsibility). Keeps it simple, apps control their own initialization.

## Implementation Plan

### Phase 1: Service Discovery for /app

1. Modify `load-services.ts` to also scan `/app/*/service.json`
2. Resolve relative handler paths to app directory
3. Register with service name = directory name

### Phase 2: Cleanup

1. Delete `rom/app/init.ts`
2. Remove `DEFAULT_INIT_PATH` from `src/os/os.ts`
3. Update AGENTS.md documentation

### Phase 3: Create service.json for existing apps

For each app in `/app/*/`, create appropriate service.json:

| App | Suggested Activation |
|-----|---------------------|
| `displayd` | `boot` (if display enabled) or `manual` |
| `httpd` | `tcp:listen` on configured port |
| `agentd` | `manual` |
| `ai` | `manual` |
| `crond` | `boot` |
| `timerd` | `boot` |

### Phase 4: Model Loading Migration

Move model loading from init.ts to individual apps or remove if unused.

## Files to Modify

| File | Change |
|------|--------|
| `src/kernel/kernel/load-services.ts` | Add `/app/*/service.json` scanning |
| `src/kernel/kernel/load-services-from-dir.ts` | Handle relative handler paths |
| `src/os/os.ts` | Remove `DEFAULT_INIT_PATH` |
| `rom/app/init.ts` | Delete |
| `rom/app/*/service.json` | Create for each app |
| `AGENTS.md` | Update documentation |

## API

No new APIs needed. Existing service API works:

```typescript
// Start an app
await os.service('start', 'ai');

// Stop an app
await os.service('stop', 'ai');

// List services (includes app services)
const services = await os.service('list');
```

## Testing Considerations

- `TestOS` skips services by default (`skipServices: true`) - apps won't auto-start
- Tests can selectively start apps: `os.service('start', 'ai')`
- No change to test infrastructure needed

## Migration Notes

- Existing `/etc/services/` definitions continue to work unchanged
- Apps without `service.json` are not registered (opt-in)
- Boot-time apps need explicit `"activate": "boot"` in service.json
