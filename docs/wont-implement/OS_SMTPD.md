# SMTP Daemon (smtpd)

> **Status:** Won't implement in core OS. External service.

Email sending service for Monk OS.

**Note**: This is a userspace service installed via `os.install()`, not built into the core OS. See `OS_SERVICES.md` for the service architecture.

---

## Installation & Usage

```typescript
import { OS } from '@anthropic/monk-os';

const os = new OS();
await os.boot();

// Install smtpd package
await os.install('@anthropic/monk-smtpd');

// Start smtpd service
await os.service('start', 'smtpd', {
    smtp: process.env.SMTP_URL,           // smtp://user:pass@host:587
    from: 'noreply@example.com',
    rateLimit: { perMinute: 100 },
});

// Send email via pubsub
await os.call('smtp.send', {
    to: 'user@example.com',
    subject: 'Hello',
    text: 'Hello from smtpd!',
});
```

---

## Overview

Two complementary components:

1. **SMTP Channel** (`BunSmtpChannel`) - Low-level HAL channel for sending emails
2. **smtpd Service** (optional) - Higher-level daemon with queuing, retries, templates

For MVP (authd magic links), only the SMTP channel is required.

---

## Feasibility Assessment

### What Exists

| Component | Status | Notes |
|-----------|--------|-------|
| Channel infrastructure | ✅ | `Channel` interface, `BunChannelDevice` |
| Service infrastructure | ✅ | Boot/pubsub activation |
| VFS for queue storage | ✅ | EMS for persistent queue |

### What's Needed

| Component | Complexity | Notes |
|-----------|------------|-------|
| SMTP protocol | Medium | Use `nodemailer` or raw SMTP |
| TLS support | Low | Built into nodemailer/Bun |
| Connection pooling | Low | Nodemailer handles this |
| Queue persistence | Medium | Only needed for smtpd service |

### External Dependencies

| Option | Pros | Cons |
|--------|------|------|
| `nodemailer` | Battle-tested, full-featured | Large dependency |
| Raw SMTP (net) | No dependencies | Complex, error-prone |
| External API (SendGrid, etc.) | Simple HTTP | Requires account, costs money |

**Recommendation**: Use `nodemailer` for reliability. It's well-tested and handles edge cases (TLS, auth, encoding).

---

## Part 1: SMTP Channel

Simple send-only channel for immediate email dispatch.

### Interface

```typescript
// Message to send email
interface SmtpSendMessage {
    op: 'send';
    data: {
        to: string | string[];
        subject: string;
        text?: string;
        html?: string;
        from?: string;          // Override default from
        replyTo?: string;
        cc?: string | string[];
        bcc?: string | string[];
        attachments?: Attachment[];
    };
}

interface Attachment {
    filename: string;
    content: Uint8Array | string;  // bytes or base64
    contentType?: string;
}

// Response
{ op: 'ok', data: { messageId: string } }
{ op: 'error', data: { code: string, message: string } }
```

### Channel Options

```typescript
interface SmtpChannelOpts extends ChannelOpts {
    // From smtp:// URL or explicit
    host?: string;
    port?: number;
    secure?: boolean;           // TLS
    auth?: {
        user: string;
        pass: string;
    };

    // Defaults
    from?: string;              // Default from address
    replyTo?: string;           // Default reply-to
}
```

### URL Format

```
smtp://user:pass@smtp.example.com:587
smtps://user:pass@smtp.example.com:465
```

### Implementation

```typescript
// src/hal/channel/smtp.ts

import { createTransport, type Transporter } from 'nodemailer';
import type { Channel, ChannelOpts } from './types.js';
import type { Message, Response } from '@src/message.js';
import { respond } from '@src/message.js';

export class BunSmtpChannel implements Channel {
    readonly id: string;
    readonly proto = 'smtp';
    readonly description: string;

    private transporter: Transporter;
    private defaultFrom?: string;
    private _closed = false;

    constructor(url: string, opts?: SmtpChannelOpts) {
        this.id = crypto.randomUUID();
        this.description = `smtp:${new URL(url).host}`;
        this.defaultFrom = opts?.from;

        // Parse URL and create transporter
        const parsed = new URL(url);
        this.transporter = createTransport({
            host: parsed.hostname,
            port: parseInt(parsed.port) || (parsed.protocol === 'smtps:' ? 465 : 587),
            secure: parsed.protocol === 'smtps:',
            auth: parsed.username ? {
                user: decodeURIComponent(parsed.username),
                pass: decodeURIComponent(parsed.password),
            } : undefined,
        });
    }

    get closed(): boolean {
        return this._closed;
    }

    async *handle(msg: Message): AsyncIterable<Response> {
        if (this._closed) {
            yield respond.error('EBADF', 'Channel closed');
            return;
        }

        if (msg.op !== 'send') {
            yield respond.error('EINVAL', `Unknown op: ${msg.op}`);
            return;
        }

        const data = msg.data as SmtpSendData;

        try {
            const result = await this.transporter.sendMail({
                from: data.from ?? this.defaultFrom,
                to: Array.isArray(data.to) ? data.to.join(', ') : data.to,
                cc: data.cc,
                bcc: data.bcc,
                replyTo: data.replyTo,
                subject: data.subject,
                text: data.text,
                html: data.html,
                attachments: data.attachments?.map(a => ({
                    filename: a.filename,
                    content: a.content,
                    contentType: a.contentType,
                })),
            });

            yield respond.ok({ messageId: result.messageId });
        } catch (err) {
            const error = err as Error;
            yield respond.error('EIO', error.message);
        }
    }

    async push(): Promise<void> {
        throw new Error('SMTP channels do not support push');
    }

    async recv(): Promise<Message> {
        throw new Error('SMTP channels do not support recv');
    }

    async close(): Promise<void> {
        if (this._closed) return;
        this._closed = true;
        this.transporter.close();
    }
}
```

### Registration

Add to `BunChannelDevice.open()`:

```typescript
case 'smtp':
case 'smtps':
    return new BunSmtpChannel(url, opts);
```

### Usage

```typescript
import { channel } from '/lib/process';

// Open SMTP channel
const smtp = await channel.open('smtp', 'smtp://user:pass@smtp.example.com:587', {
    from: 'noreply@example.com',
});

// Send email
const result = await channel.call(smtp, {
    op: 'send',
    data: {
        to: 'recipient@example.com',
        subject: 'Hello',
        text: 'This is a test email.',
        html: '<p>This is a <strong>test</strong> email.</p>',
    },
});

console.log('Sent:', result.data.messageId);

await channel.close(smtp);
```

---

## Part 2: smtpd Service (Optional)

Higher-level email service with queuing, retries, and templates.

### Why a Daemon?

| Feature | Channel Only | With smtpd |
|---------|--------------|------------|
| Send email | ✅ | ✅ |
| Retry on failure | ❌ | ✅ |
| Persistent queue | ❌ | ✅ |
| Rate limiting | ❌ | ✅ |
| Templates | ❌ | ✅ |
| Delivery tracking | ❌ | ✅ |
| Multiple providers | ❌ | ✅ |

### Service Definition

```json
// /etc/services/smtpd.json
{
    "handler": "/sbin/smtpd.ts",
    "activate": { "type": "boot" },
    "io": {
        "stdin": { "type": "pubsub", "subscribe": ["smtp.*"] },
        "stdout": { "type": "console" },
        "stderr": { "type": "console" }
    }
}
```

### Operations

| Topic | Input | Output | Description |
|-------|-------|--------|-------------|
| `smtp.send` | Email data | `{ queued: id }` | Queue email for delivery |
| `smtp.status` | `{ id }` | Status info | Check delivery status |
| `smtp.cancel` | `{ id }` | `{ ok }` | Cancel queued email |
| `smtp.template.render` | Template + data | Rendered email | Render template |

### Queue Model (EMS)

```sql
-- Email queue table
CREATE TABLE IF NOT EXISTS email_queue (
    id          TEXT PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    trashed_at  TEXT,
    expired_at  TEXT,

    owner       TEXT NOT NULL,

    -- Email content
    mail_from   TEXT NOT NULL,
    mail_to     TEXT NOT NULL,              -- JSON array
    subject     TEXT NOT NULL,
    body_text   TEXT,
    body_html   TEXT,
    headers     TEXT,                       -- JSON object

    -- Queue state
    status      TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    attempts    INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    next_attempt TEXT,                      -- ISO timestamp
    last_error  TEXT,
    sent_at     TEXT,
    message_id  TEXT                        -- From SMTP server
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status, next_attempt);
```

### smtpd Implementation

```typescript
// rom/sbin/smtpd.ts

import { recv, send, channel, sleep } from '/lib/process';
import { ems } from '/lib/ems';

// Load config
const config = JSON.parse(await readFile('/etc/smtp/config.json'));

// Open SMTP channel
const smtp = await channel.open('smtp', config.smtp, { from: config.from });

// Start queue processor in background
processQueue();

// Handle incoming requests
for await (const msg of recv(stdin)) {
    const topic = msg.from;
    const data = msg.meta;

    try {
        switch (topic) {
            case 'smtp.send':
                await handleSend(data, msg.replyTo);
                break;
            case 'smtp.status':
                await handleStatus(data, msg.replyTo);
                break;
            case 'smtp.cancel':
                await handleCancel(data, msg.replyTo);
                break;
        }
    } catch (err) {
        await send(msg.replyTo, { error: err.message });
    }
}

async function handleSend(data: EmailData, replyTo: string) {
    // Queue the email
    const [email] = await collect(ems.createAll('email_queue', [{
        mail_from: data.from ?? config.from,
        mail_to: JSON.stringify(Array.isArray(data.to) ? data.to : [data.to]),
        subject: data.subject,
        body_text: data.text,
        body_html: data.html,
        status: 'pending',
        next_attempt: new Date().toISOString(),
    }]));

    await send(replyTo, { queued: email.id });
}

async function processQueue() {
    while (true) {
        // Find pending emails ready for attempt
        const pending = await collect(ems.selectAny('email_queue', {
            where: {
                status: { $in: ['pending', 'failed'] },
                next_attempt: { $lte: new Date().toISOString() },
                attempts: { $lt: { $field: 'max_attempts' } },
            },
            limit: 10,
        }));

        for (const email of pending) {
            await attemptSend(email);
        }

        await sleep(5000); // Check every 5 seconds
    }
}

async function attemptSend(email: EmailQueueRecord) {
    // Mark as sending
    await collect(ems.updateIds('email_queue', [email.id], {
        status: 'sending',
        attempts: email.attempts + 1,
    }));

    try {
        const result = await channel.call(smtp, {
            op: 'send',
            data: {
                from: email.mail_from,
                to: JSON.parse(email.mail_to),
                subject: email.subject,
                text: email.body_text,
                html: email.body_html,
            },
        });

        // Mark as sent
        await collect(ems.updateIds('email_queue', [email.id], {
            status: 'sent',
            sent_at: new Date().toISOString(),
            message_id: result.data.messageId,
        }));
    } catch (err) {
        // Mark as failed, schedule retry
        const nextAttempt = new Date(Date.now() + exponentialBackoff(email.attempts));

        await collect(ems.updateIds('email_queue', [email.id], {
            status: 'failed',
            last_error: err.message,
            next_attempt: nextAttempt.toISOString(),
        }));
    }
}

function exponentialBackoff(attempts: number): number {
    // 1min, 5min, 30min
    const delays = [60_000, 300_000, 1800_000];
    return delays[Math.min(attempts, delays.length - 1)];
}
```

### Templates (Optional)

```typescript
// /etc/smtp/templates/magic-link.html
const template = `
<!DOCTYPE html>
<html>
<body>
    <h1>Sign in to {{appName}}</h1>
    <p>Click the link below to sign in:</p>
    <a href="{{link}}">Sign In</a>
    <p>This link expires in {{expiresIn}} minutes.</p>
</body>
</html>
`;

// Usage
await send('smtp.template.render', {
    template: 'magic-link',
    data: {
        appName: 'MyApp',
        link: 'https://myapp.com/auth/callback?token=xxx',
        expiresIn: 10,
    },
    replyTo: `smtp.response.${requestId}`,
});
```

---

## Implementation Plan

### Phase 1: SMTP Channel (MVP)

1. Add `nodemailer` dependency
2. Create `src/hal/channel/smtp.ts`
3. Register in `BunChannelDevice`
4. Add tests with mock SMTP server
5. Update authd to use SMTP channel

### Phase 2: smtpd Service (Optional)

1. Add `email_queue` table to EMS schema
2. Create `/sbin/smtpd.ts` service
3. Add service definition
4. Implement queue processing
5. Add retry logic with backoff

### Phase 3: Templates (Optional)

1. Choose template engine (Handlebars, Mustache, or simple replace)
2. Add template storage in `/etc/smtp/templates/`
3. Add `smtp.template.render` operation
4. Create default templates for auth flows

---

## Configuration

```json
// /etc/smtp/config.json
{
    "smtp": "smtp://user:pass@smtp.example.com:587",
    "from": "noreply@example.com",
    "replyTo": "support@example.com",

    "queue": {
        "maxAttempts": 3,
        "retryDelays": [60, 300, 1800]
    },

    "rateLimit": {
        "perMinute": 100,
        "perHour": 1000
    }
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| `ECONNREFUSED` | Cannot connect to SMTP server |
| `EAUTH` | Authentication failed |
| `EENVELOPE` | Invalid sender/recipient |
| `EMESSAGE` | Message rejected by server |
| `ETIMEDOUT` | Connection timeout |
| `EIO` | General SMTP error |

---

## Testing

### Mock SMTP Server

```typescript
// tests/smtp.test.ts
import { createServer } from 'smtp-server';

const mockServer = new SMTPServer({
    onData(stream, session, callback) {
        // Capture email for assertions
        let data = '';
        stream.on('data', chunk => data += chunk);
        stream.on('end', () => {
            capturedEmails.push(parseEmail(data));
            callback();
        });
    },
});

await mockServer.listen(2525);

// Test
const smtp = await channel.open('smtp', 'smtp://localhost:2525');
await channel.call(smtp, {
    op: 'send',
    data: { to: 'test@example.com', subject: 'Test', text: 'Hello' },
});

expect(capturedEmails).toHaveLength(1);
expect(capturedEmails[0].subject).toBe('Test');
```

---

## Open Questions

| Question | Options | Notes |
|----------|---------|-------|
| Template engine | Handlebars vs Mustache vs none | Mustache is simpler, fewer deps |
| Attachment storage | Inline vs VFS reference | Inline for small, VFS for large |
| Bounce handling | Webhook vs poll | Future consideration |
| DKIM signing | In smtpd vs external | External (Postfix, etc.) for now |

---

## References

- `src/hal/channel/http.ts` - Similar channel pattern
- `src/hal/channel/types.ts` - Channel interface
- [nodemailer docs](https://nodemailer.com/)
- OS_AUTHD.md - Primary consumer (magic links)
