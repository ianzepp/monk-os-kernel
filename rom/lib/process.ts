/**
 * Process Library for VFS Scripts
 *
 * Provides syscall wrappers for VFS-based scripts.
 * This file re-exports everything from the modular process/ directory.
 */

export * from './process/index';

// Re-export ByteReader/ByteWriter from io library
export { ByteReader, ByteWriter } from '@rom/lib/io';
