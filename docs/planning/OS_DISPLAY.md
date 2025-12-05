# OS Display System

A browser-based display server using EMS entities and EntityMount.

## Status

| Component | Status | Notes |
|-----------|--------|-------|
| HAL JsonDevice | ✅ Done | `hal.json.encode/decode` |
| HAL YamlDevice | ✅ Done | `hal.yaml.encode/decode` using `Bun.YAML.parse` |
| displayd package | ✅ Done | YAML model definitions in `packages/displayd/models/` |
| Model loader | ⏳ Pending | Load YAML models via `os.install()` → `PackageAPI` |
| EntityMount for /dev/display | ⏳ Pending | Auto-mount from package manifest |
| jsond EMS integration | ⏳ Pending | WebSocket streaming of entity changes |
| display-client | ⏳ Pending | Browser webapp for rendering |

### Completed Models (packages/displayd/models/)

| Model | Fields | Notes |
|-------|--------|-------|
| display | 7 | Browser session (width, height, dpi, connected, session_id, user_agent, last_ping) |
| window | 21 | Application window (position, size, focus, z-order, owner_pid, opacity, etc.) |
| element | 15 | DOM element (tag, props, text, order, layout hints) - passthrough |
| event | 17 | Input event (type, coordinates, modifiers, key) - passthrough |
| cursor | 7 | Mouse state (position, style, visibility) - passthrough |
| selection | 9 | Text selection (offsets, direction, collapsed) |

### Next Steps

1. **Model loader in PackageAPI** - Extend `pkg.ts`:
   ```typescript
   // In install(), after mounting:
   const monkConfig = pkgJson.monk as MonkConfig | undefined;
   if (monkConfig?.models) {
       await this.loadModels(hostPath, monkConfig.models);
   }
   ```

2. **YAML → EMS transformation** - Parse model YAML and upsert:
   ```typescript
   for (const modelName of models) {
       const yaml = await hal.file.readText(`${hostPath}/models/${modelName}.yaml`);
       const def = hal.yaml.decode(yaml);
       await ems.ops.upsertAll('models', [transformModel(def)]);
       await ems.ops.upsertAll('fields', transformFields(def));
   }
   ```

3. **Auto-mount EntityMount** - From package manifest:
   ```json
   "monk": {
       "mounts": [{ "path": "/dev/display", "model": "display", "field": "id" }]
   }
   ```

4. **jsond EMS operations** - Add `ems:*` message handlers to jsond

5. **display-client webapp** - Browser renderer connecting via WebSocket

## Overview

The display system exposes a graphical interface to browsers using the existing EMS infrastructure. Instead of a custom display protocol, displays, windows, and elements are EMS entities that:

- Auto-expose via EntityMount at `/dev/display/`
- CRUD via standard `ems:*` syscalls
- Stream to browsers via jsond
- Leverage the observer pipeline for validation and sync

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (display-client webapp)                     │
│  ┌───────────────────────────────────────────────┐  │
│  │  Window Manager                               │  │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐          │  │
│  │  │ Window 1│ │ Window 2│ │ Window 3│          │  │
│  │  │ (proc A)│ │ (proc B)│ │ (proc A)│          │  │
│  │  └─────────┘ └─────────┘ └─────────┘          │  │
│  └───────────────────────────────────────────────┘  │
│         ▲ EMS entities       │ EMS events           │
└─────────┼────────────────────┼──────────────────────┘
          │    WebSocket       │
          │    (jsond)         │
          │                    ▼
┌─────────┴────────────────────┴──────────────────────┐
│  jsond + EntityMount                                 │
│  - Browser connects via WebSocket                    │
│  - Creates display entity (claims display ID)        │
│  - Streams window/element changes                    │
│  - Receives input events as entity creates           │
└─────────────────────────────────────────────────────┘
          ▲                    │
          │                    ▼
┌─────────┴────────────────────┴──────────────────────┐
│  /dev/display/  (EntityMount)                        │
│    {display-id}/                                     │
│      fields/                                         │
│        width, height, dpi, connected                 │
│      relationships/                                  │
│        windows/                                      │
│          {window-id}/                                │
│            fields/                                   │
│              title, x, y, width, height              │
│            relationships/                            │
│              elements/                               │
│                {element-id}/                         │
│                  fields/                             │
│                    tag, props, text                  │
└─────────────────────────────────────────────────────┘
          ▲                    │
          │                    ▼
┌─────────┴────────────────────┴──────────────────────┐
│  User Processes                                      │
│  - shell, editor, apps                               │
│  - ems:create window, elements                       │
│  - ems:update to change UI                           │
│  - ems:select to stream input events                 │
└─────────────────────────────────────────────────────┘
```

## Entity Models

> **Implementation**: See `packages/displayd/models/*.yaml` for full field definitions.
> TypeScript types in `packages/displayd/types.ts`.

### display

Represents a browser session/connection.

| Field       | Type    | Description                    |
|-------------|---------|--------------------------------|
| id          | string  | Display ID (e.g., "0", "1")    |
| width       | number  | Screen width in pixels         |
| height      | number  | Screen height in pixels        |
| dpi         | number  | Device pixel ratio             |
| connected   | boolean | Browser currently connected    |
| session_id  | string  | Browser session identifier     |
| user_agent  | string  | Browser user agent             |
| last_ping   | timestamp | Last heartbeat               |

### window

Represents a window owned by a process.

| Field      | Type    | Description                     |
|------------|---------|----------------------------------|
| id         | string  | Window ID                        |
| display_id | string  | Parent display (relationship)    |
| title      | string  | Window title                     |
| x, y       | number  | Position in pixels               |
| width, height | number | Size in pixels                |
| min/max_width/height | number | Size constraints        |
| z_index    | number  | Stacking order                   |
| focused    | boolean | Has keyboard focus               |
| visible    | boolean | Is visible                       |
| minimized  | boolean | Window is minimized              |
| maximized  | boolean | Window is maximized              |
| resizable  | boolean | Can be resized                   |
| movable    | boolean | Can be moved                     |
| closable   | boolean | Can be closed                    |
| owner_pid  | string  | Owning process UUID              |
| background | string  | Background color/CSS             |
| opacity    | number  | Window opacity (0-1)             |

### element

Represents a DOM element within a window. Uses `passthrough: true` for performance.

| Field      | Type        | Description                     |
|------------|-------------|----------------------------------|
| id         | string      | Element ID                       |
| window_id  | string      | Parent window (relationship)     |
| parent_id  | string/null | Parent element (null = root)     |
| tag        | string      | HTML tag (div, button, input)    |
| props      | JSON        | Attributes, class, style         |
| text       | string/null | Text content                     |
| order      | number      | Sibling order                    |
| disabled   | boolean     | Element is disabled              |
| hidden     | boolean     | Element is hidden                |
| value      | string      | Input value                      |
| placeholder | string     | Input placeholder                |

### event

Represents an input event from the browser. Uses `passthrough: true` for performance.

| Field       | Type   | Description                      |
|-------------|--------|----------------------------------|
| id          | string | Event ID                         |
| display_id  | string | Source display                   |
| window_id   | string | Target window                    |
| element_id  | string | Target element (if any)          |
| type        | enum   | click, keydown, input, etc.      |
| data        | JSON   | Event-specific data              |
| timestamp   | number | Unix timestamp (ms)              |
| key         | string | Key pressed (keyboard events)    |
| button      | number | Mouse button (0=left, 2=right)   |
| x, y        | number | Coordinates                      |
| shift/ctrl/alt/meta | boolean | Modifier keys           |
| handled     | boolean | Event has been processed        |

### cursor

Mouse cursor state per display. Uses `passthrough: true` for performance.

| Field       | Type   | Description                      |
|-------------|--------|----------------------------------|
| display_id  | string | Parent display (unique)          |
| x, y        | number | Cursor position                  |
| style       | enum   | CSS cursor style                 |
| visible     | boolean | Cursor is visible               |
| window_id   | string | Window cursor is over            |
| element_id  | string | Element cursor is over           |

### selection

Text selection state within a window.

| Field       | Type   | Description                      |
|-------------|--------|----------------------------------|
| window_id   | string | Window containing selection      |
| element_id  | string | Element containing selection     |
| text        | string | Selected text                    |
| start/end_offset | number | Selection offsets           |
| collapsed   | boolean | Is caret only (no selection)    |
| direction   | enum   | forward, backward, none          |

## Protocol

Browser and OS communicate via jsond using standard EMS operations.

### Browser → OS

```typescript
// Connect and create display
{ op: 'ems:create', model: 'display', fields: { width: 1920, height: 1080, dpi: 2 } }

// Send input event
{ op: 'ems:create', model: 'event', fields: {
  display_id: '0',
  window_id: 'w1',
  element_id: 'btn1',
  type: 'click',
  data: { x: 100, y: 50 }
}}

// Disconnect
{ op: 'ems:update', model: 'display', id: '0', changes: { connected: false } }
```

### OS → Browser

```typescript
// Stream windows for this display
{ op: 'ems:select', model: 'window', filter: { display_id: '0' } }

// Stream elements for windows
{ op: 'ems:select', model: 'element', filter: { window_id: 'w1' } }
```

### Process API

```typescript
// Query available displays
for await (const display of ems.select('display', { connected: true })) {
  console.log(`Display ${display.id}: ${display.width}x${display.height}`);
}

// Create window
const window = await ems.create('window', {
  display_id: '0',
  title: 'My App',
  x: 100, y: 100,
  width: 800, height: 600
});

// Create elements
await ems.create('element', {
  window_id: window.id,
  parent_id: null,
  tag: 'div',
  props: { class: 'container' }
});

await ems.create('element', {
  window_id: window.id,
  parent_id: 'e1',
  tag: 'button',
  props: { class: 'btn' },
  text: 'Click me'
});

// Handle events
for await (const event of ems.select('event', { window_id: window.id })) {
  if (event.type === 'click' && event.element_id === 'btn1') {
    await ems.update('element', 'btn1', { text: 'Clicked!' });
  }
}
```

## displayd Package Structure

Server-side display daemon (implemented):

```
packages/displayd/
  package.json            # Manifest with monk.models, monk.mounts
  index.ts                # Package entry point
  types.ts                # TypeScript interfaces for all models
  models/
    display.yaml          # Browser session
    window.yaml           # Application window
    element.yaml          # DOM element
    event.yaml            # Input event
    cursor.yaml           # Mouse state
    selection.yaml        # Text selection
```

## displayd-client Package

Browser webapp (not yet implemented):

```
packages/displayd-client/
  package.json
  src/
    index.ts              # Entry point
    connection.ts         # jsond WebSocket client
    renderer.ts           # Element tree → DOM
    window-manager.ts     # Window chrome, drag, resize, focus
    events.ts             # DOM events → EMS event entities
  public/
    index.html            # Shell page
  dist/
    displayd-client.js    # Bundled output
```

### Responsibilities

1. **Connect** to jsond via WebSocket
2. **Create** display entity on connect
3. **Stream** window and element entities
4. **Render** element tree as DOM
5. **Capture** DOM events and create event entities
6. **Manage** window chrome (title bar, resize, close)

## EntityMount Configuration

```typescript
// Mount displays at /dev/display
await vfs.mountEntity('/dev/display', { model: 'display', field: 'id' });
```

This exposes:

```
/dev/display/
  0/
    fields/
      width
      height
      dpi
      connected
    relationships/
      windows/
        w1/
          fields/
            title
            x
            y
            ...
          relationships/
            elements/
              e1/
                fields/
                  tag
                  props
                  text
```

## Benefits

1. **No custom protocol** - Uses existing EMS/jsond infrastructure
2. **Persistence** - Display state survives restarts (if desired)
3. **ACL** - Per-entity access control for windows
4. **Observers** - Validation, triggers, audit logging
5. **Streaming** - Built-in via EMS select
6. **Relationships** - Hierarchical structure via EntityMount

## Performance

**Conclusion: YES, EMS is fast enough for 60fps updates.**

Benchmark results from `perf/ems/display-refresh.perf.ts` (M3 Pro, SQLite in-memory):

| Scenario | Avg/Frame | FPS Achieved | Target |
|----------|-----------|--------------|--------|
| Single element update (cursor) | ~50μs | ~20,000 | 60 |
| Batch 50 elements (scroll) | ~2.2ms | ~450 | 60 |
| Batch 200 elements (reflow) | ~8ms | ~125 | 60 |
| Query 200 elements (render) | ~250μs | ~4,000 | 60 |
| Hit test (single lookup) | ~19μs | ~53,000 | 60 |
| Full frame (query + update 10) | ~700μs | ~1,400 | 60 |
| 1000 elements (10% update) | ~5.4ms | ~185 | 60 |

All scenarios exceed 60fps by 2x or more. The likely bottlenecks will be:
- Network/WebSocket latency
- Browser DOM rendering
- JSON serialization overhead

### Optimization Options

If performance tuning is needed:

1. **Passthrough models** (already configured) - Skip observer rings 2-7:
   ```yaml
   # packages/displayd/models/element.yaml
   name: element
   passthrough: true  # Bypasses validation, transforms, triggers
   ```
   Already set for: `element`, `event`, `cursor`

2. **Volatile models** (potential feature) - Memory-only, no disk persistence:
   ```sql
   ALTER TABLE models ADD COLUMN volatile INTEGER DEFAULT 0;
   ```

3. **Backend routing** (potential feature) - Route models to different databases:
   - `window` → PostgreSQL (persistent)
   - `cursor`, `selection` → SQLite `:memory:` (transient)

4. **Batched sync** - Coalesce multiple element updates before WebSocket send

### Recommendation

Start with standard EMS. Use passthrough models for `element` and `event` entities
if needed. The benchmark shows no optimization is required for typical workloads
(up to 1000 elements at 60fps).

## Open Questions

1. ~~**Performance** - Is EMS fast enough for 60fps updates?~~ **YES** - See benchmarks above
2. **Event TTL** - Should events auto-expire?
3. **Styles** - Inline props vs CSS classes vs stylesheets?
4. **Components** - Higher-level widgets (text input, list)?
5. **Canvas** - Support for `<canvas>` with draw commands?
6. **Clipboard** - How to handle copy/paste?
7. **Drag & Drop** - Between windows? Between displays?

## Future Enhancements

- **Themes** - System-wide theming via EMS entities
- **Accessibility** - ARIA attributes in element props
- **Touch** - Multi-touch event support
- **Audio** - Audio output via `/dev/audio`
- **Notifications** - System notifications model
