# Shell Heredoc Support

## Summary

The Monk OS shell does not support heredoc syntax (`<< DELIMITER`), which is commonly used for writing multiline content to files.

## Current Behavior

```sh
cat > /bin/rev << 'EOF'
#!/usr/bin/env bun
console.log('hello');
EOF
```

Fails with: `cat: <: No such file: /<`

The parser treats `<<` as two separate `<` redirects rather than a heredoc operator.

## Expected Behavior

Heredoc syntax should work as in bash/zsh:
- `<< DELIM` - heredoc with variable expansion
- `<< 'DELIM'` or `<< "DELIM"` - literal heredoc (no expansion)
- Content collected until `DELIM` appears on its own line
- Content passed as stdin to the command

## Workaround

Use `printf` with escaped newlines:

```sh
printf '#!/usr/bin/env bun\nconsole.log("hello");\n' > /bin/rev
```

## Implementation Notes

Changes needed:
1. `rom/lib/shell/types.ts` - Add `heredocDelimiter?: string` and `heredocContent?: string` to `ParsedCommand`
2. `rom/lib/shell/parse.ts` - Detect `<<` operator, extract delimiter
3. `rom/bin/shell.ts` - Collect lines until delimiter, inject as stdin

For Prior/LLM usage, the heredoc content would need to be sent as a single multiline `!exec` command.

## Priority

Medium - Workaround exists with printf, but heredocs are more readable for multiline content.
