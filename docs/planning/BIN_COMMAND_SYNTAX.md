# Bin Command Syntax

## Problem

LLMs (including Claude) are primarily trained on Linux systems with GNU coreutils. When executing shell commands, they naturally use GNU-style syntax:

```bash
head -5 file.txt          # GNU shorthand
tail -20 file.txt         # GNU shorthand
grep -r pattern .         # GNU recursive
```

But many implementations (including POSIX-compliant systems) require explicit option syntax:

```bash
head -n 5 file.txt        # POSIX
tail -n 20 file.txt       # POSIX
grep -R pattern .         # POSIX (capital R)
```

This mismatch causes command failures when Prior uses its trained intuition.

## Decision

**Support both GNU and POSIX syntax, document POSIX as canonical.**

Rationale:
1. We control `/bin` - we can implement whatever we want
2. Fighting the model's training is futile and wasteful
3. Supporting both costs minimal implementation effort
4. Help text shows "proper" form for human users

## Implementation Guidelines

### Numeric Options

Commands that take numeric arguments should support both styles:

| Command | GNU Style | POSIX Style | Both Work |
|---------|-----------|-------------|-----------|
| head | `-5` | `-n 5` | Yes |
| tail | `-5` | `-n 5` | Yes |
| cut | N/A | `-c 1-5` | N/A |

Implementation pattern:
```typescript
// In argument parsing
for (const arg of args) {
    if (arg.match(/^-\d+$/)) {
        // GNU shorthand: -5 means -n 5
        lines = parseInt(arg.slice(1), 10);
    }
    else if (arg === '-n' && i + 1 < args.length) {
        // POSIX: -n 5
        lines = parseInt(args[++i], 10);
    }
    else if (arg.match(/^-n\d+$/)) {
        // POSIX combined: -n5
        lines = parseInt(arg.slice(2), 10);
    }
}
```

### Flag Options

Support both short and long forms where GNU provides them:

| Command | Short | Long | Both Work |
|---------|-------|------|-----------|
| ls | `-a` | `--all` | Yes |
| ls | `-l` | `--long` | Yes |
| grep | `-i` | `--ignore-case` | Yes |
| grep | `-r` | `--recursive` | Yes |

### Help Text

Always document the POSIX/standard form:

```
Usage: head [-n LINES] [FILE...]

Options:
  -n LINES    Output first LINES lines (default: 10)
  --help      Display this help

Examples:
  head -n 5 /tmp/log.txt        Output first 5 lines
  cat file.txt | head -n 3      Read from stdin
```

The `-5` shorthand works but isn't advertised.

## Commands to Update

Priority order based on LLM usage frequency:

### High Priority
- [ ] `head` - add `-N` shorthand
- [ ] `tail` - add `-N` shorthand
- [ ] `grep` - verify `-r` works (alias for `-R`)

### Medium Priority
- [ ] `ls` - verify long options work
- [ ] `cut` - check delimiter syntax
- [ ] `sort` - check `-n`, `-r`, `-k` options

### Low Priority
- [ ] `wc` - simple enough, probably fine
- [ ] `tr` - character class syntax
- [ ] `sed` - regex flavor differences

## Testing

Add tests that verify both syntaxes work:

```typescript
test('head supports GNU shorthand', async () => {
    // -5 should work same as -n 5
    const gnu = await exec('head -5 /tmp/test.txt');
    const posix = await exec('head -n 5 /tmp/test.txt');
    expect(gnu).toEqual(posix);
});
```

## Non-Goals

- Full GNU compatibility (too much baggage)
- Matching every GNU edge case
- Supporting obscure options nobody uses

Focus on the 80% case: common options that LLMs actually generate.
