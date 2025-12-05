/**
 * Process Library for VFS Scripts
 *
 * Provides syscall wrappers for VFS-based userspace programs.
 * This file re-exports everything from the modular process/ directory.
 *
 * CRITICAL: MESSAGE-BASED I/O
 * ===========================
 * Monk OS uses structured Response messages for inter-process communication,
 * NOT Unix-style byte streams. This is fundamentally different from POSIX.
 *
 * Two types of I/O:
 *
 * 1. MESSAGE I/O (for pipes and fd 0/1/2) - see process/pipe.ts
 *    - recv(fd) → yields Response messages
 *    - send(fd, msg) → sends Response message
 *    - Used for: process stdin/stdout/stderr, inter-process pipes
 *
 * 2. BYTE I/O (for files and sockets) - see io.ts
 *    - read(fd) → yields Uint8Array chunks
 *    - write(fd, bytes) → writes raw bytes
 *    - Used for: file contents, network sockets, binary data
 *
 * The shell must handle the message↔byte boundary when redirecting
 * process output (messages) to files (bytes).
 *
 * @module rom/lib/process
 */

export * from './process/index';

// Re-export ByteReader/ByteWriter from io library for byte-stream operations
export { ByteReader, ByteWriter } from '@rom/lib/io';
