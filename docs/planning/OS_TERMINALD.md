# Terminal Daemon (terminald)

> **Status**: Planning
> **Complexity**: Medium
> **Package**: `@anthropic/monk-terminald`
> **Dependencies**: `@anthropic/monk-httpd` (or standalone HTTP)

Web-based terminal access to the Monk OS shell.

**Note**: This provides access to the **Monk OS shell** (`/bin/shell.ts`), not the host system shell. All commands execute in the VFS with userspace programs from `rom/`.

---

## Overview

terminald provides a full terminal experience in the browser:

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (xterm.js)                                          │
│  ┌─────────────────────────────────────────────────────────┐│
│  │ $ ls /bin                                               ││
│  │ cat  echo  grep  ls  mkdir  rm  shell  ...              ││
│  │ $ cat /etc/motd                                         ││
│  │ Welcome to Monk OS                                      ││
│  │ $ _                                                     ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

This is the Monk VFS shell - commands like `ls`, `cat`, `grep` are TypeScript programs in `rom/bin/` running as Monk OS processes.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                     │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  xterm.js                                               ││
│  │  - Terminal emulator (renders output, captures input)   ││
│  │  - Handles ANSI escape codes (colors, cursor)           ││
│  │  - Sends keystrokes, receives output                    ││
│  └──────────────────────────┬──────────────────────────────┘│
│                             │ WebSocket                      │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│  terminald                                                   │
│  - Serves static HTML/JS (xterm.js)                         │
│  - Accepts WebSocket connections                            │
│  - Spawns /bin/shell as Monk OS process                     │
│  - Bridges: WebSocket ↔ shell stdin/stdout                  │
│  - Handles resize messages                                  │
└─────────────────────────────┬───────────────────────────────┘
                              │ Process I/O
┌─────────────────────────────▼───────────────────────────────┐
│  /bin/shell.ts (Monk OS process)                             │
│  - Runs in VFS, not host system                             │
│  - Executes rom/bin/* commands                              │
│  - Uses ConsoleHandle for I/O                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Installation & Usage

```typescript
import { OS } from '@anthropic/monk-os';

const os = new OS();
await os.boot();

await os.install('@anthropic/monk-terminald');

await os.service('start', 'terminald', {
    port: 3000,
    auth: {
        // Optional: require auth token
        token: process.env.TERMINAL_TOKEN,
    },
});

// Terminal available at http://localhost:3000
```

---

## Components

### 1. Static Frontend

Minimal HTML page with xterm.js:

```html
<!-- /var/terminald/index.html -->
<!DOCTYPE html>
<html>
<head>
    <title>Monk OS Terminal</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm/css/xterm.css" />
    <style>
        body { margin: 0; background: #1e1e1e; }
        #terminal { height: 100vh; }
    </style>
</head>
<body>
    <div id="terminal"></div>
    <script src="https://cdn.jsdelivr.net/npm/xterm/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-web-links/lib/xterm-addon-web-links.js"></script>
    <script>
        const term = new Terminal({
            cursorBlink: true,
            fontSize: 14,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            theme: {
                background: '#1e1e1e',
                foreground: '#d4d4d4',
            },
        });

        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.loadAddon(new WebLinksAddon.WebLinksAddon());

        term.open(document.getElementById('terminal'));
        fitAddon.fit();

        // Connect to WebSocket
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/ws`);

        ws.onopen = () => {
            // Send initial size
            ws.send(JSON.stringify({
                type: 'resize',
                cols: term.cols,
                rows: term.rows,
            }));
        };

        ws.onmessage = (event) => {
            term.write(event.data);
        };

        ws.onclose = () => {
            term.write('\r\n\x1b[31mConnection closed\x1b[0m\r\n');
        };

        term.onData((data) => {
            ws.send(JSON.stringify({ type: 'input', data }));
        });

        window.addEventListener('resize', () => {
            fitAddon.fit();
            ws.send(JSON.stringify({
                type: 'resize',
                cols: term.cols,
                rows: term.rows,
            }));
        });
    </script>
</body>
</html>
```

### 2. WebSocket Server

terminald handles HTTP and WebSocket:

```typescript
// rom/sbin/terminald.ts

import { spawn, kill, wait } from '/lib/process';

const config = JSON.parse(await readFile('/etc/terminald/config.json'));

// Simple HTTP server using Bun.serve (via HAL)
const server = Bun.serve({
    port: config.port,

    fetch(req, server) {
        const url = new URL(req.url);

        // Auth check
        if (config.auth?.token) {
            const token = url.searchParams.get('token') ||
                          req.headers.get('Authorization')?.replace('Bearer ', '');
            if (token !== config.auth.token) {
                return new Response('Unauthorized', { status: 401 });
            }
        }

        // WebSocket upgrade
        if (url.pathname === '/ws') {
            if (server.upgrade(req)) {
                return; // Upgraded
            }
            return new Response('WebSocket upgrade failed', { status: 400 });
        }

        // Serve static frontend
        if (url.pathname === '/' || url.pathname === '/index.html') {
            return new Response(indexHtml, {
                headers: { 'Content-Type': 'text/html' },
            });
        }

        return new Response('Not found', { status: 404 });
    },

    websocket: {
        open(ws) {
            // Spawn shell process
            const shellPid = await spawn('/bin/shell', {
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
                env: {
                    TERM: 'xterm-256color',
                    COLUMNS: '80',
                    LINES: '24',
                },
            });

            ws.data = { shellPid };

            // Pipe shell output to WebSocket
            pipeOutputToWebSocket(shellPid, ws);
        },

        message(ws, message) {
            const msg = JSON.parse(message);

            switch (msg.type) {
                case 'input':
                    // Send to shell stdin
                    writeToProcess(ws.data.shellPid, msg.data);
                    break;

                case 'resize':
                    // Update shell's terminal size
                    // This would need env var update or signal
                    setProcessEnv(ws.data.shellPid, {
                        COLUMNS: String(msg.cols),
                        LINES: String(msg.rows),
                    });
                    break;
            }
        },

        close(ws) {
            // Kill shell process
            if (ws.data?.shellPid) {
                kill(ws.data.shellPid);
            }
        },
    },
});

console.log(`Terminal available at http://localhost:${config.port}`);
```

### 3. Shell Enhancements

The current shell may need enhancements for full terminal experience:

| Feature | Current Status | Needed For |
|---------|----------------|------------|
| ANSI colors | ✅ Likely works | Colored output |
| Line editing | ? Check | Arrow keys, backspace |
| History | ? Check | Up/down arrows |
| Tab completion | ? Check | Tab to complete |
| Ctrl+C handling | ? Check | Interrupt current command |
| TERM env var | ❌ Needs check | Terminal capability detection |
| COLUMNS/LINES | ❌ Needs check | Proper line wrapping |

---

## Message Protocol

WebSocket messages are JSON:

```typescript
// Client → Server
interface InputMessage {
    type: 'input';
    data: string;      // Raw keystrokes
}

interface ResizeMessage {
    type: 'resize';
    cols: number;
    rows: number;
}

// Server → Client
// Raw terminal output (not JSON, just bytes/string)
```

---

## Configuration

```typescript
interface TerminaldConfig {
    /** Port to listen on */
    port: number;

    /** Optional authentication */
    auth?: {
        /** Simple token auth */
        token?: string;

        /** Or delegate to authd */
        authd?: boolean;
    };

    /** Shell to spawn (default: /bin/shell) */
    shell?: string;

    /** Initial environment */
    env?: Record<string, string>;

    /** Session timeout (ms, 0 = no timeout) */
    timeout?: number;
}
```

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Unauthorized access | Require auth token or authd validation |
| Session hijacking | Use secure WebSocket (wss://) in production |
| Resource exhaustion | Limit concurrent sessions, add timeout |
| Command injection | N/A - shell is sandboxed to VFS |

The Monk OS shell is inherently sandboxed:
- Only VFS access, no host filesystem
- Only rom/bin/* commands, no host binaries
- Process isolation via kernel

---

## Implementation Plan

### Phase 1: Basic Terminal

1. Create `@anthropic/monk-terminald` package structure
2. Implement static HTML/xterm.js frontend
3. Implement WebSocket server (using Bun.serve directly or via HAL)
4. Bridge WebSocket ↔ shell process I/O
5. Basic auth (token-based)

### Phase 2: Shell Enhancements

1. Audit `/bin/shell.ts` for terminal features
2. Add TERM environment variable support
3. Add COLUMNS/LINES handling
4. Ensure ANSI escape codes work
5. Test with xterm.js

### Phase 3: Production Features

1. HTTPS support (or run behind httpd)
2. Integration with authd
3. Session management (multiple terminals)
4. Connection timeout
5. Logging

---

## Dependencies

### HAL Requirements

| Component | Status | Notes |
|-----------|--------|-------|
| WebSocket support | ❌ | Need `BunWebSocketChannel` or direct Bun.serve |
| Process I/O pipes | ✅ | Exists via spawn() |

### Shell Requirements

| Feature | Status | Notes |
|---------|--------|-------|
| stdin/stdout | ✅ | Via ConsoleHandle |
| ANSI output | ? | Needs verification |
| Line editing | ? | Needs verification |
| Signal handling | ? | Ctrl+C, etc. |

---

## Alternative: Standalone Bun.serve

terminald could bypass the HAL channel system entirely and use Bun.serve directly:

```typescript
// terminald uses Bun.serve, not HAL channels
// This is simpler for HTTP+WebSocket combo
// HAL channels are better for protocol abstraction (SMTP, PostgreSQL, etc.)
```

This is reasonable because:
- Bun.serve handles both HTTP and WebSocket elegantly
- No need for channel abstraction here
- Simpler implementation

---

## Package Structure

```
@anthropic/monk-terminald/
├── package.json
├── manifest.json
├── sbin/
│   └── terminald.ts       # Main service
├── var/
│   └── terminald/
│       └── index.html     # xterm.js frontend
└── etc/
    └── terminald/
        └── config.schema.json
```

### manifest.json

```json
{
    "name": "terminald",
    "version": "1.0.0",
    "description": "Web-based terminal for Monk OS shell",

    "handler": "/sbin/terminald.ts",

    "install": {
        "files": {
            "/sbin/terminald.ts": "sbin/terminald.ts",
            "/var/terminald/index.html": "var/terminald/index.html"
        }
    },

    "config": {
        "schema": "etc/terminald/config.schema.json",
        "required": ["port"]
    }
}
```

---

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| Bun.serve vs HAL | Direct Bun.serve | Simpler for HTTP+WS |
| Multiple sessions | Per-connection shell | Each WS = new shell process |
| Shell features | Enhance shell? | May need readline improvements |
| Copy/paste | xterm.js handles | Browser clipboard API |

---

## References

- [xterm.js](https://xtermjs.org/) - Terminal emulator for browser
- `rom/bin/shell.ts` - Monk OS shell implementation
- `OS_SERVICES.md` - Service architecture
- [Bun.serve WebSocket](https://bun.sh/docs/api/websockets) - Bun WebSocket docs
