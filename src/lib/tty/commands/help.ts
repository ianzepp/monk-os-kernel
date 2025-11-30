/**
 * help - Show available commands
 */

import type { CommandHandler } from './shared.js';

export const help: CommandHandler = async (_session, _fs, _args, io) => {
    io.stdout.write('Available commands:\n');
    io.stdout.write('  Navigation:  cd, pwd, ls, find\n');
    io.stdout.write('  Files:       cat, touch, rm, mv, jq\n');
    io.stdout.write('  Directories: mkdir, rmdir\n');
    io.stdout.write('  Search:      grep, xargs\n');
    io.stdout.write('  Info:        echo, whoami, env, export\n');
    io.stdout.write('  Session:     clear, help, man, exit\n');
    io.stdout.write('  Process:     sleep, timeout, ps, kill\n');
    io.stdout.write('\nPaths:\n');
    io.stdout.write('  /api/data      - Model records (CRUD)\n');
    io.stdout.write('  /api/describe  - Model schemas\n');
    io.stdout.write('  /api/find      - Saved queries\n');
    io.stdout.write('  /api/trashed   - Soft-deleted records\n');
    io.stdout.write('  /system        - System info\n');
    io.stdout.write('  /home, /tmp    - File storage\n');
    return 0;
};
