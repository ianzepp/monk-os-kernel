# Bug: Cat Infinite Loop in Pipeline

## Summary
When `cat` receives a message from a pipe (e.g., `echo hello | cat`), it enters an infinite send loop and times out. However, when the pipe is empty (e.g., `true | cat`), EOF propagates correctly and cat exits cleanly.

## Working Cases
1. **`true | cat`** - Works! Cat receives EOF (`recv -> done`) and exits cleanly with code 0
2. **MessagePipe in isolation** - The perf tests pass, so the pipe itself handles EOF correctly
3. **Child stderr** - Cat successfully writes error messages to stderr (inherited from shell)

## Broken Case
**`echo hello | cat`** - Cat does many sends, hits backpressure (gap=1000), times out after 5 seconds

## Debug Output Comparison

### Working: `true | cat`
```
handle:redirect -> ok
handle:restore -> ok     # true (builtin) completes immediately
spawn -> ok              # cat spawns AFTER true finishes
close -> ok              # pipe write end closed
...
recv -> done             # cat gets EOF immediately
exit -> error: 0         # cat exits cleanly
```

### Broken: `echo hello | cat`
```
handle:redirect -> ok
send -> ok               # echo writes to pipe
spawn -> ok              # cat spawns
handle:restore -> ok
close -> ok              # pipe closed
...
recv                     # cat starts recv
send -> ok               # cat sends (many times!)
recv -> backpressure     # stuck after 1000 sends
```

## Key Observation
- `true` outputs nothing → cat gets EOF immediately
- `echo` outputs one message → cat does ~1000 sends and times out

The difference is that echo actually **writes a message to the pipe**. When there's a message, something goes wrong. When the pipe is empty, EOF propagates correctly.

## Hypothesis
The issue might be in:
1. How cat processes the received message
2. How the console stdout handle behaves when receiving that message
3. Some interaction between the message response and the kernel's streaming/backpressure mechanism

## Relevant Code

### Cat stdin passthrough (rom/bin/cat.ts)
```typescript
if (files.length === 0) {
    for await (const msg of recv(0)) {
        await send(1, msg);
    }
    await exit(0);
}
```

### MessagePipe EOF handling (src/kernel/resource/message-pipe.ts)
```typescript
private async *doRecv(): AsyncIterable<Response> {
    while (true) {
        const msg = await this.queue.recv();
        if (msg === null) {
            yield respond.done();
            return;
        }
        yield msg;
    }
}
```

### Console send handling (src/kernel/handle/console.ts)
```typescript
private async *send(msg: Response): AsyncIterable<Response> {
    // ... extracts text from item messages and writes to console ...
    yield respond.ok();
}
```

## Test Cases
- `spec/kernel/shell.test.ts`: "should handle simple pipe (echo | cat)" - FAILS
- `spec/kernel/shell.test.ts`: "should pipe true output to cat" - PASSES

## Isolation Testing Strategy

### Already Tested in Isolation
- **MessagePipe** - Perf tests pass, EOF works correctly

### Suggested Isolation Tests

#### 1. ConsoleHandleAdapter send behavior
Test that sending an item message to the console stdout adapter works correctly and terminates:
```typescript
const console = new BufferConsoleDevice();
const adapter = new ConsoleHandleAdapter(uuid, console, 'stdout');
const msg = respond.item({ text: 'hello\n' });

for await (const r of adapter.exec({ op: 'send', data: msg })) {
    // Should yield exactly one 'ok' response
}
```

#### 2. Kernel's `send` syscall with console handle
Test the full syscall path for writing to console, without spawning a process.

#### 3. Spawned process stdio inheritance
Test that a child process correctly inherits fd 1 as console (not pipe):
- Spawn a simple process that just writes to stdout
- Verify it uses the console, not some other handle

#### 4. Cat's recv→send loop in isolation
Create a pipe, write one message, close send end, then have cat-like code read and forward:
```typescript
const [recvEnd, sendEnd] = createMessagePipe('test');
const consoleAdapter = new ConsoleHandleAdapter(...);

// Write message and close
sendEnd.exec({ op: 'send', data: respond.item({ text: 'hello' }) });
sendEnd.close();

// Cat-like loop
for await (const msg of recvEnd.exec({ op: 'recv' })) {
    if (msg.op === 'done') break;
    for await (const r of consoleAdapter.exec({ op: 'send', data: msg })) {
        // Should get 'ok'
    }
}
```

### Most Likely Culprit
Given that `true | cat` works (empty pipe → EOF) but `echo | cat` doesn't (one message → infinite loop), start with **#1 or #4** - specifically testing what happens when the console adapter receives an item message and whether it somehow triggers more recv iterations.

## Related
- Shell pipeline fix in `rom/bin/shell.ts` (moved close loop after Promise.all, added builtin pipe close)
- Kernel streaming backpressure in `src/kernel/kernel.ts` (STREAM_HIGH_WATER = 1000)
