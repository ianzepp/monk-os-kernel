/**
 * AWK Lexer
 *
 * Tokenizes AWK source code into tokens.
 */

import type { Token, TokenType } from './types.js';

const KEYWORDS: Record<string, TokenType> = {
    'BEGIN': 'BEGIN',
    'END': 'END',
    'if': 'IF',
    'else': 'ELSE',
    'while': 'WHILE',
    'for': 'FOR',
    'do': 'DO',
    'break': 'BREAK',
    'continue': 'CONTINUE',
    'next': 'NEXT',
    'exit': 'EXIT',
    'function': 'FUNCTION',
    'return': 'RETURN',
    'delete': 'DELETE',
    'in': 'IN',
    'getline': 'GETLINE',
    'print': 'PRINT',
    'printf': 'PRINTF',
};

export class Lexer {
    private source: string;
    private pos: number = 0;
    private line: number = 1;
    private column: number = 1;
    private tokens: Token[] = [];

    // Track context for regex vs division disambiguation
    private lastTokenType: TokenType | null = null;

    constructor(source: string) {
        this.source = source;
    }

    tokenize(): Token[] {
        while (!this.isAtEnd()) {
            this.scanToken();
        }

        this.tokens.push({
            type: 'EOF',
            value: '',
            line: this.line,
            column: this.column,
        });

        return this.tokens;
    }

    private scanToken(): void {
        this.skipWhitespaceAndComments();
        if (this.isAtEnd()) return;

        const start = this.pos;
        const startLine = this.line;
        const startColumn = this.column;
        const c = this.advance();

        // Newline (significant in AWK for statement termination)
        if (c === '\n') {
            // Only emit newline if it's significant
            if (this.isSignificantNewline()) {
                this.addToken('NEWLINE', '\n', startLine, startColumn);
            }
            return;
        }

        // String literal
        if (c === '"') {
            this.string(startLine, startColumn);
            return;
        }

        // Regex literal - only in certain contexts
        if (c === '/' && this.canStartRegex()) {
            this.regex(startLine, startColumn);
            return;
        }

        // Number
        if (this.isDigit(c) || (c === '.' && this.isDigit(this.peek()))) {
            this.number(start, startLine, startColumn);
            return;
        }

        // Identifier or keyword
        if (this.isAlpha(c) || c === '_') {
            this.identifier(start, startLine, startColumn);
            return;
        }

        // Field reference $
        if (c === '$') {
            this.field(startLine, startColumn);
            return;
        }

        // Operators and delimiters
        switch (c) {
            case '+':
                if (this.match('+')) {
                    this.addToken('INCREMENT', '++', startLine, startColumn);
                } else if (this.match('=')) {
                    this.addToken('PLUS_ASSIGN', '+=', startLine, startColumn);
                } else {
                    this.addToken('PLUS', '+', startLine, startColumn);
                }
                break;

            case '-':
                if (this.match('-')) {
                    this.addToken('DECREMENT', '--', startLine, startColumn);
                } else if (this.match('=')) {
                    this.addToken('MINUS_ASSIGN', '-=', startLine, startColumn);
                } else {
                    this.addToken('MINUS', '-', startLine, startColumn);
                }
                break;

            case '*':
                if (this.match('=')) {
                    this.addToken('STAR_ASSIGN', '*=', startLine, startColumn);
                } else {
                    this.addToken('STAR', '*', startLine, startColumn);
                }
                break;

            case '/':
                if (this.match('=')) {
                    this.addToken('SLASH_ASSIGN', '/=', startLine, startColumn);
                } else {
                    this.addToken('SLASH', '/', startLine, startColumn);
                }
                break;

            case '%':
                if (this.match('=')) {
                    this.addToken('PERCENT_ASSIGN', '%=', startLine, startColumn);
                } else {
                    this.addToken('PERCENT', '%', startLine, startColumn);
                }
                break;

            case '^':
                if (this.match('=')) {
                    this.addToken('CARET_ASSIGN', '^=', startLine, startColumn);
                } else {
                    this.addToken('CARET', '^', startLine, startColumn);
                }
                break;

            case '=':
                if (this.match('=')) {
                    this.addToken('EQ', '==', startLine, startColumn);
                } else {
                    this.addToken('ASSIGN', '=', startLine, startColumn);
                }
                break;

            case '!':
                if (this.match('=')) {
                    this.addToken('NE', '!=', startLine, startColumn);
                } else if (this.match('~')) {
                    this.addToken('NOT_MATCH', '!~', startLine, startColumn);
                } else {
                    this.addToken('NOT', '!', startLine, startColumn);
                }
                break;

            case '<':
                if (this.match('=')) {
                    this.addToken('LE', '<=', startLine, startColumn);
                } else {
                    this.addToken('LT', '<', startLine, startColumn);
                }
                break;

            case '>':
                if (this.match('=')) {
                    this.addToken('GE', '>=', startLine, startColumn);
                } else if (this.match('>')) {
                    this.addToken('APPEND', '>>', startLine, startColumn);
                } else {
                    this.addToken('GT', '>', startLine, startColumn);
                }
                break;

            case '&':
                if (this.match('&')) {
                    this.addToken('AND', '&&', startLine, startColumn);
                }
                // Single & not used in AWK
                break;

            case '|':
                if (this.match('|')) {
                    this.addToken('OR', '||', startLine, startColumn);
                } else {
                    this.addToken('PIPE', '|', startLine, startColumn);
                }
                break;

            case '~':
                this.addToken('MATCH', '~', startLine, startColumn);
                break;

            case '?':
                this.addToken('QUESTION', '?', startLine, startColumn);
                break;

            case ':':
                this.addToken('COLON', ':', startLine, startColumn);
                break;

            case '(':
                this.addToken('LPAREN', '(', startLine, startColumn);
                break;

            case ')':
                this.addToken('RPAREN', ')', startLine, startColumn);
                break;

            case '{':
                this.addToken('LBRACE', '{', startLine, startColumn);
                break;

            case '}':
                this.addToken('RBRACE', '}', startLine, startColumn);
                break;

            case '[':
                this.addToken('LBRACKET', '[', startLine, startColumn);
                break;

            case ']':
                this.addToken('RBRACKET', ']', startLine, startColumn);
                break;

            case ',':
                this.addToken('COMMA', ',', startLine, startColumn);
                break;

            case ';':
                this.addToken('SEMICOLON', ';', startLine, startColumn);
                break;

            default:
                throw new Error(`Unexpected character '${c}' at line ${startLine}, column ${startColumn}`);
        }
    }

    private string(startLine: number, startColumn: number): void {
        let value = '';

        while (!this.isAtEnd() && this.peek() !== '"') {
            if (this.peek() === '\n') {
                throw new Error(`Unterminated string at line ${startLine}`);
            }

            if (this.peek() === '\\') {
                this.advance();
                if (this.isAtEnd()) break;

                const escaped = this.advance();
                switch (escaped) {
                    case 'n': value += '\n'; break;
                    case 't': value += '\t'; break;
                    case 'r': value += '\r'; break;
                    case '\\': value += '\\'; break;
                    case '"': value += '"'; break;
                    case '/': value += '/'; break;
                    case 'b': value += '\b'; break;
                    case 'f': value += '\f'; break;
                    default: value += escaped;
                }
            } else {
                value += this.advance();
            }
        }

        if (this.isAtEnd()) {
            throw new Error(`Unterminated string at line ${startLine}`);
        }

        this.advance(); // closing "
        this.addToken('STRING', value, startLine, startColumn);
    }

    private regex(startLine: number, startColumn: number): void {
        let pattern = '';

        while (!this.isAtEnd() && this.peek() !== '/') {
            if (this.peek() === '\n') {
                throw new Error(`Unterminated regex at line ${startLine}`);
            }

            if (this.peek() === '\\') {
                pattern += this.advance();
                if (!this.isAtEnd()) {
                    pattern += this.advance();
                }
            } else {
                pattern += this.advance();
            }
        }

        if (this.isAtEnd()) {
            throw new Error(`Unterminated regex at line ${startLine}`);
        }

        this.advance(); // closing /
        this.addToken('REGEX', pattern, startLine, startColumn);
    }

    private number(start: number, startLine: number, startColumn: number): void {
        // Back up to include first digit
        this.pos = start;
        this.column = startColumn;

        while (this.isDigit(this.peek())) {
            this.advance();
        }

        // Decimal part
        if (this.peek() === '.' && this.isDigit(this.peekNext())) {
            this.advance(); // consume .
            while (this.isDigit(this.peek())) {
                this.advance();
            }
        }

        // Exponent
        if (this.peek() === 'e' || this.peek() === 'E') {
            this.advance();
            if (this.peek() === '+' || this.peek() === '-') {
                this.advance();
            }
            while (this.isDigit(this.peek())) {
                this.advance();
            }
        }

        const value = this.source.slice(start, this.pos);
        this.addToken('NUMBER', value, startLine, startColumn);
    }

    private identifier(start: number, startLine: number, startColumn: number): void {
        while (this.isAlphaNumeric(this.peek())) {
            this.advance();
        }

        const text = this.source.slice(start, this.pos);
        const type = KEYWORDS[text] || 'IDENTIFIER';
        this.addToken(type, text, startLine, startColumn);
    }

    private field(startLine: number, startColumn: number): void {
        // $0, $1, $NF, $(expr)
        if (this.peek() === '(') {
            // $(expr) - handled as FIELD token, parser handles the expression
            this.addToken('FIELD', '$', startLine, startColumn);
            return;
        }

        // $0, $1, $NF, $var
        let fieldSpec = '';
        if (this.isDigit(this.peek())) {
            while (this.isDigit(this.peek())) {
                fieldSpec += this.advance();
            }
        } else if (this.isAlpha(this.peek()) || this.peek() === '_') {
            while (this.isAlphaNumeric(this.peek())) {
                fieldSpec += this.advance();
            }
        }

        this.addToken('FIELD', '$' + fieldSpec, startLine, startColumn);
    }

    private skipWhitespaceAndComments(): void {
        while (!this.isAtEnd()) {
            const c = this.peek();

            if (c === ' ' || c === '\t' || c === '\r') {
                this.advance();
            } else if (c === '#') {
                // Comment until end of line
                while (!this.isAtEnd() && this.peek() !== '\n') {
                    this.advance();
                }
            } else if (c === '\\' && this.peekNext() === '\n') {
                // Line continuation
                this.advance(); // backslash
                this.advance(); // newline
            } else {
                break;
            }
        }
    }

    private canStartRegex(): boolean {
        // Regex can appear after:
        // - Nothing (start of input)
        // - Operators: ~ !~ , ; { ( || && == != < > <= >=
        // - Keywords: if while for do
        // - Beginning of pattern

        if (this.lastTokenType === null) return true;

        const regexPrecedingTokens: TokenType[] = [
            'MATCH', 'NOT_MATCH', 'COMMA', 'SEMICOLON', 'NEWLINE',
            'LBRACE', 'LPAREN', 'OR', 'AND', 'EQ', 'NE',
            'LT', 'GT', 'LE', 'GE', 'NOT', 'QUESTION', 'COLON',
            'IF', 'WHILE', 'FOR', 'DO', 'RETURN',
            'ASSIGN', 'PLUS_ASSIGN', 'MINUS_ASSIGN', 'STAR_ASSIGN',
            'SLASH_ASSIGN', 'PERCENT_ASSIGN', 'CARET_ASSIGN',
        ];

        return regexPrecedingTokens.includes(this.lastTokenType);
    }

    private isSignificantNewline(): boolean {
        // Newlines are significant for statement termination
        // but not after certain tokens
        if (this.lastTokenType === null) return false;

        const insignificantAfter: TokenType[] = [
            'COMMA', 'LBRACE', 'LPAREN', 'LBRACKET',
            'OR', 'AND', 'QUESTION', 'COLON',
            'PLUS', 'MINUS', 'STAR', 'SLASH', 'PERCENT', 'CARET',
            'EQ', 'NE', 'LT', 'GT', 'LE', 'GE',
            'MATCH', 'NOT_MATCH',
            'ASSIGN', 'PLUS_ASSIGN', 'MINUS_ASSIGN', 'STAR_ASSIGN',
            'SLASH_ASSIGN', 'PERCENT_ASSIGN', 'CARET_ASSIGN',
            'NEWLINE', 'SEMICOLON',
        ];

        return !insignificantAfter.includes(this.lastTokenType);
    }

    private addToken(type: TokenType, value: string, line: number, column: number): void {
        this.tokens.push({ type, value, line, column });
        this.lastTokenType = type;
    }

    private advance(): string {
        const c = this.source[this.pos++];
        if (c === '\n') {
            this.line++;
            this.column = 1;
        } else {
            this.column++;
        }
        return c;
    }

    private match(expected: string): boolean {
        if (this.isAtEnd()) return false;
        if (this.source[this.pos] !== expected) return false;
        this.pos++;
        this.column++;
        return true;
    }

    private peek(): string {
        if (this.isAtEnd()) return '\0';
        return this.source[this.pos];
    }

    private peekNext(): string {
        if (this.pos + 1 >= this.source.length) return '\0';
        return this.source[this.pos + 1];
    }

    private isAtEnd(): boolean {
        return this.pos >= this.source.length;
    }

    private isDigit(c: string): boolean {
        return c >= '0' && c <= '9';
    }

    private isAlpha(c: string): boolean {
        return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    }

    private isAlphaNumeric(c: string): boolean {
        return this.isAlpha(c) || this.isDigit(c) || c === '_';
    }
}
