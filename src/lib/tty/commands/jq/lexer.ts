/**
 * jq Lexer - Tokenizes jq expressions
 *
 * Converts a jq expression string into a stream of tokens for parsing.
 */

import type { Token, TokenType } from './types.js';

const KEYWORDS: Record<string, TokenType> = {
    'true': 'TRUE',
    'false': 'FALSE',
    'null': 'NULL',
    'and': 'AND',
    'or': 'OR',
    'not': 'NOT',
    'if': 'IDENT',
    'then': 'IDENT',
    'else': 'IDENT',
    'elif': 'IDENT',
    'end': 'IDENT',
    'try': 'IDENT',
    'catch': 'IDENT',
    'as': 'AS',
};

export class Lexer {
    private input: string;
    private position: number = 0;
    private tokens: Token[] = [];

    constructor(input: string) {
        this.input = input;
    }

    tokenize(): Token[] {
        while (this.position < this.input.length) {
            this.skipWhitespace();
            if (this.position >= this.input.length) break;

            const char = this.input[this.position];

            // Two-character operators
            if (this.position + 1 < this.input.length) {
                const twoChar = this.input.slice(this.position, this.position + 2);
                if (twoChar === '..') {
                    this.addToken('DOTDOT', '..');
                    this.position += 2;
                    continue;
                }
                if (twoChar === '==') {
                    this.addToken('EQ', '==');
                    this.position += 2;
                    continue;
                }
                if (twoChar === '!=') {
                    this.addToken('NE', '!=');
                    this.position += 2;
                    continue;
                }
                if (twoChar === '<=') {
                    this.addToken('LE', '<=');
                    this.position += 2;
                    continue;
                }
                if (twoChar === '>=') {
                    this.addToken('GE', '>=');
                    this.position += 2;
                    continue;
                }
                if (twoChar === '//') {
                    // Alternative operator - treat as division for now
                    this.addToken('SLASH', '/');
                    this.position += 1;
                    continue;
                }
            }

            // Single-character tokens
            switch (char) {
                case '.':
                    this.addToken('DOT', '.');
                    this.position++;
                    break;
                case '|':
                    this.addToken('PIPE', '|');
                    this.position++;
                    break;
                case '+':
                    this.addToken('PLUS', '+');
                    this.position++;
                    break;
                case '-':
                    this.addToken('MINUS', '-');
                    this.position++;
                    break;
                case '*':
                    this.addToken('STAR', '*');
                    this.position++;
                    break;
                case '/':
                    this.addToken('SLASH', '/');
                    this.position++;
                    break;
                case '%':
                    this.addToken('PERCENT', '%');
                    this.position++;
                    break;
                case '<':
                    this.addToken('LT', '<');
                    this.position++;
                    break;
                case '>':
                    this.addToken('GT', '>');
                    this.position++;
                    break;
                case '?':
                    this.addToken('QUESTION', '?');
                    this.position++;
                    break;
                case ':':
                    this.addToken('COLON', ':');
                    this.position++;
                    break;
                case ';':
                    this.addToken('SEMICOLON', ';');
                    this.position++;
                    break;
                case ',':
                    this.addToken('COMMA', ',');
                    this.position++;
                    break;
                case '[':
                    this.addToken('LBRACKET', '[');
                    this.position++;
                    break;
                case ']':
                    this.addToken('RBRACKET', ']');
                    this.position++;
                    break;
                case '{':
                    this.addToken('LBRACE', '{');
                    this.position++;
                    break;
                case '}':
                    this.addToken('RBRACE', '}');
                    this.position++;
                    break;
                case '(':
                    this.addToken('LPAREN', '(');
                    this.position++;
                    break;
                case ')':
                    this.addToken('RPAREN', ')');
                    this.position++;
                    break;
                case '"':
                    this.readString();
                    break;
                case '$':
                    this.readVariable();
                    break;
                default:
                    if (this.isDigit(char)) {
                        this.readNumber();
                    } else if (this.isIdentStart(char)) {
                        this.readIdentifier();
                    } else {
                        throw new Error(`Unexpected character '${char}' at position ${this.position}`);
                    }
            }
        }

        this.addToken('EOF', null);
        return this.tokens;
    }

    private skipWhitespace(): void {
        while (this.position < this.input.length) {
            const char = this.input[this.position];
            if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                this.position++;
            } else if (char === '#') {
                // Skip comments
                while (this.position < this.input.length && this.input[this.position] !== '\n') {
                    this.position++;
                }
            } else {
                break;
            }
        }
    }

    private addToken(type: TokenType, value: string | number | null): void {
        this.tokens.push({ type, value, position: this.position });
    }

    private isDigit(char: string): boolean {
        return char >= '0' && char <= '9';
    }

    private isIdentStart(char: string): boolean {
        return (char >= 'a' && char <= 'z') ||
               (char >= 'A' && char <= 'Z') ||
               char === '_';
    }

    private isIdentChar(char: string): boolean {
        return this.isIdentStart(char) || this.isDigit(char);
    }

    private readString(): void {
        const start = this.position;
        this.position++; // Skip opening quote

        let value = '';
        while (this.position < this.input.length) {
            const char = this.input[this.position];

            if (char === '"') {
                this.position++; // Skip closing quote
                this.tokens.push({ type: 'STRING', value, position: start });
                return;
            }

            if (char === '\\' && this.position + 1 < this.input.length) {
                this.position++;
                const escaped = this.input[this.position];
                switch (escaped) {
                    case 'n': value += '\n'; break;
                    case 't': value += '\t'; break;
                    case 'r': value += '\r'; break;
                    case '"': value += '"'; break;
                    case '\\': value += '\\'; break;
                    case '/': value += '/'; break;
                    default: value += escaped;
                }
                this.position++;
            } else {
                value += char;
                this.position++;
            }
        }

        throw new Error(`Unterminated string starting at position ${start}`);
    }

    private readNumber(): void {
        const start = this.position;
        let value = '';

        // Integer part
        while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
            value += this.input[this.position];
            this.position++;
        }

        // Decimal part
        if (this.position < this.input.length && this.input[this.position] === '.') {
            // Check it's not .. operator
            if (this.position + 1 < this.input.length && this.input[this.position + 1] === '.') {
                // It's .., don't consume
            } else if (this.position + 1 < this.input.length && this.isDigit(this.input[this.position + 1])) {
                value += '.';
                this.position++;
                while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
                    value += this.input[this.position];
                    this.position++;
                }
            }
        }

        // Exponent part
        if (this.position < this.input.length &&
            (this.input[this.position] === 'e' || this.input[this.position] === 'E')) {
            value += this.input[this.position];
            this.position++;
            if (this.position < this.input.length &&
                (this.input[this.position] === '+' || this.input[this.position] === '-')) {
                value += this.input[this.position];
                this.position++;
            }
            while (this.position < this.input.length && this.isDigit(this.input[this.position])) {
                value += this.input[this.position];
                this.position++;
            }
        }

        this.tokens.push({ type: 'NUMBER', value: parseFloat(value), position: start });
    }

    private readIdentifier(): void {
        const start = this.position;
        let value = '';

        while (this.position < this.input.length && this.isIdentChar(this.input[this.position])) {
            value += this.input[this.position];
            this.position++;
        }

        const type = KEYWORDS[value] || 'IDENT';
        this.tokens.push({ type, value, position: start });
    }

    private readVariable(): void {
        const start = this.position;
        this.position++; // Skip $

        let value = '$';
        while (this.position < this.input.length && this.isIdentChar(this.input[this.position])) {
            value += this.input[this.position];
            this.position++;
        }

        this.tokens.push({ type: 'IDENT', value, position: start });
    }
}
