/**
 * Shell Types
 *
 * Core type definitions for shell parsing and execution.
 */

/**
 * Parsed command structure
 *
 * Represents a single command with its arguments, redirects, and chaining.
 * Commands can be chained via pipes (|), and-then (&&), or-else (||).
 */
export interface ParsedCommand {
    /** Command name */
    command: string;

    /** Command arguments (after variable/quote expansion) */
    args: string[];

    /** Input redirect file (< file) */
    inputRedirect?: string;

    /** Output redirect file (> file) */
    outputRedirect?: string;

    /** Append redirect file (>> file) */
    appendRedirect?: string;

    /** Next command in pipeline (|) */
    pipe?: ParsedCommand;

    /** Next command if this succeeds (&&) */
    andThen?: ParsedCommand;

    /** Next command if this fails (||) */
    orElse?: ParsedCommand;

    /** Run in background (&) */
    background: boolean;
}
