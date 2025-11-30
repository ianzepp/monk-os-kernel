/**
 * jq Parser - Builds AST from tokens
 *
 * Recursive descent parser for jq expressions.
 * Operator precedence (lowest to highest):
 *   |        pipe
 *   ,        comma (multiple outputs)
 *   or       logical or
 *   and      logical and
 *   == !=    equality
 *   < <= > >=  comparison
 *   + -      additive
 *   * / %    multiplicative
 *   unary    - not
 *   postfix  . [] () ?
 */

import type { Token, TokenType, ASTNode, ObjectEntry } from './types.js';
import { Lexer } from './lexer.js';

export class Parser {
    private tokens: Token[] = [];
    private position: number = 0;

    parse(input: string): ASTNode {
        const lexer = new Lexer(input);
        this.tokens = lexer.tokenize();
        this.position = 0;

        const result = this.parseExpression();

        if (!this.isAtEnd()) {
            throw new Error(`Unexpected token: ${this.current().value}`);
        }

        return result;
    }

    // ==========================================================================
    // Token helpers
    // ==========================================================================

    private current(): Token {
        return this.tokens[this.position] || { type: 'EOF', value: null, position: -1 };
    }

    private peek(offset: number = 0): Token {
        return this.tokens[this.position + offset] || { type: 'EOF', value: null, position: -1 };
    }

    private isAtEnd(): boolean {
        return this.current().type === 'EOF';
    }

    private check(type: TokenType): boolean {
        return this.current().type === type;
    }

    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.position++;
                return true;
            }
        }
        return false;
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) {
            return this.tokens[this.position++];
        }
        throw new Error(`${message}, got ${this.current().type}`);
    }

    // ==========================================================================
    // Expression parsing (by precedence)
    // ==========================================================================

    private parseExpression(): ASTNode {
        return this.parsePipe();
    }

    // Pipe: expr | expr
    private parsePipe(): ASTNode {
        let left = this.parseOr();

        while (this.match('PIPE')) {
            const right = this.parseOr();
            left = { type: 'pipe', left, right };
        }

        return left;
    }

    // Or: expr or expr
    private parseOr(): ASTNode {
        let left = this.parseAnd();

        while (this.match('OR')) {
            const right = this.parseAnd();
            left = { type: 'binary', operator: 'or', left, right };
        }

        return left;
    }

    // And: expr and expr
    private parseAnd(): ASTNode {
        let left = this.parseEquality();

        while (this.match('AND')) {
            const right = this.parseEquality();
            left = { type: 'binary', operator: 'and', left, right };
        }

        return left;
    }

    // Equality: expr == expr, expr != expr
    private parseEquality(): ASTNode {
        let left = this.parseComparison();

        while (true) {
            if (this.match('EQ')) {
                const right = this.parseComparison();
                left = { type: 'binary', operator: '==', left, right };
            } else if (this.match('NE')) {
                const right = this.parseComparison();
                left = { type: 'binary', operator: '!=', left, right };
            } else {
                break;
            }
        }

        return left;
    }

    // Comparison: < <= > >=
    private parseComparison(): ASTNode {
        let left = this.parseAdditive();

        while (true) {
            if (this.match('LT')) {
                const right = this.parseAdditive();
                left = { type: 'binary', operator: '<', left, right };
            } else if (this.match('LE')) {
                const right = this.parseAdditive();
                left = { type: 'binary', operator: '<=', left, right };
            } else if (this.match('GT')) {
                const right = this.parseAdditive();
                left = { type: 'binary', operator: '>', left, right };
            } else if (this.match('GE')) {
                const right = this.parseAdditive();
                left = { type: 'binary', operator: '>=', left, right };
            } else {
                break;
            }
        }

        return left;
    }

    // Additive: + -
    private parseAdditive(): ASTNode {
        let left = this.parseMultiplicative();

        while (true) {
            if (this.match('PLUS')) {
                const right = this.parseMultiplicative();
                left = { type: 'binary', operator: '+', left, right };
            } else if (this.match('MINUS')) {
                const right = this.parseMultiplicative();
                left = { type: 'binary', operator: '-', left, right };
            } else {
                break;
            }
        }

        return left;
    }

    // Multiplicative: * / %
    private parseMultiplicative(): ASTNode {
        let left = this.parseUnary();

        while (true) {
            if (this.match('STAR')) {
                const right = this.parseUnary();
                left = { type: 'binary', operator: '*', left, right };
            } else if (this.match('SLASH')) {
                const right = this.parseUnary();
                left = { type: 'binary', operator: '/', left, right };
            } else if (this.match('PERCENT')) {
                const right = this.parseUnary();
                left = { type: 'binary', operator: '%', left, right };
            } else {
                break;
            }
        }

        return left;
    }

    // Unary: - not
    private parseUnary(): ASTNode {
        if (this.match('MINUS')) {
            const operand = this.parseUnary();
            return { type: 'unary', operator: '-', operand };
        }
        if (this.match('NOT')) {
            const operand = this.parseUnary();
            return { type: 'unary', operator: 'not', operand };
        }

        return this.parsePostfix();
    }

    // Postfix: . [] ? ()
    private parsePostfix(): ASTNode {
        let expr = this.parsePrimary();

        while (true) {
            if (this.match('DOT')) {
                expr = this.parseFieldAccess(expr);
            } else if (this.match('LBRACKET')) {
                expr = this.parseIndexOrSlice(expr);
            } else if (this.match('QUESTION')) {
                expr = { type: 'optional', expr };
            } else {
                break;
            }
        }

        return expr;
    }

    // Field access after dot: .field or .["field"]
    private parseFieldAccess(base: ASTNode): ASTNode {
        // Check for iterator: .[]
        if (this.check('LBRACKET')) {
            this.position++; // consume [
            if (this.match('RBRACKET')) {
                const optional = this.check('QUESTION');
                if (optional) this.position++;
                // Pipe base to iterator
                return {
                    type: 'pipe',
                    left: base,
                    right: { type: 'iterator', optional }
                };
            }
            // It's an index, back up
            this.position--;
        }

        // Regular field access
        if (this.check('IDENT') || this.check('STRING')) {
            const token = this.tokens[this.position++];
            const name = String(token.value);
            const optional = this.match('QUESTION');

            return {
                type: 'pipe',
                left: base,
                right: { type: 'field', name, optional }
            };
        }

        // Just a dot with nothing after - identity in context of postfix
        // This handles cases like ". | ."
        return base;
    }

    // Index or slice: [n], [n:m], [:]
    private parseIndexOrSlice(base: ASTNode): ASTNode {
        // Check for iterator []
        if (this.match('RBRACKET')) {
            const optional = this.match('QUESTION');
            return {
                type: 'pipe',
                left: base,
                right: { type: 'iterator', optional }
            };
        }

        // Check for slice starting with :
        if (this.check('COLON')) {
            this.position++;
            const end = this.check('RBRACKET') ? null : this.parseExpression();
            this.consume('RBRACKET', 'Expected ]');
            return {
                type: 'pipe',
                left: base,
                right: { type: 'slice', start: null, end }
            };
        }

        // Parse first expression
        const first = this.parseExpression();

        // Check for slice
        if (this.match('COLON')) {
            const end = this.check('RBRACKET') ? null : this.parseExpression();
            this.consume('RBRACKET', 'Expected ]');
            return {
                type: 'pipe',
                left: base,
                right: { type: 'slice', start: first, end }
            };
        }

        // Regular index
        this.consume('RBRACKET', 'Expected ]');
        const optional = this.match('QUESTION');
        return {
            type: 'pipe',
            left: base,
            right: { type: 'index', index: first, optional }
        };
    }

    // Primary expressions
    private parsePrimary(): ASTNode {
        // Identity: .
        if (this.check('DOT')) {
            this.position++;

            // Check for field access right after dot
            if (this.check('IDENT') || this.check('STRING')) {
                const token = this.tokens[this.position++];
                const name = String(token.value);
                const optional = this.match('QUESTION');
                return { type: 'field', name, optional };
            }

            // Check for iterator or index: .[] or .[0]
            if (this.check('LBRACKET')) {
                this.position++; // Consume [
                if (this.match('RBRACKET')) {
                    const optional = this.match('QUESTION');
                    return { type: 'iterator', optional };
                }
                // Index/slice on identity - [ is already consumed
                return this.parseIndexOrSlice({ type: 'identity' });
            }

            return { type: 'identity' };
        }

        // Recursive descent: ..
        if (this.match('DOTDOT')) {
            return { type: 'recursive' };
        }

        // Literals
        if (this.match('NUMBER')) {
            return { type: 'literal', value: this.tokens[this.position - 1].value };
        }
        if (this.match('STRING')) {
            return { type: 'literal', value: this.tokens[this.position - 1].value };
        }
        if (this.match('TRUE')) {
            return { type: 'literal', value: true };
        }
        if (this.match('FALSE')) {
            return { type: 'literal', value: false };
        }
        if (this.match('NULL')) {
            return { type: 'literal', value: null };
        }

        // Array construction: [expr, ...]
        if (this.check('LBRACKET')) {
            return this.parseArray();
        }

        // Object construction: {key: val, ...}
        if (this.check('LBRACE')) {
            return this.parseObject();
        }

        // Parenthesized expression or function call
        if (this.match('LPAREN')) {
            const expr = this.parseExpression();
            this.consume('RPAREN', 'Expected )');
            return expr;
        }

        // Identifier - could be function call or variable
        if (this.check('IDENT')) {
            const name = String(this.tokens[this.position++].value);

            // Variable reference: $var
            if (name.startsWith('$')) {
                return { type: 'variable', name: name.slice(1) };
            }

            // Check for function call with args
            if (this.match('LPAREN')) {
                const args: ASTNode[] = [];
                if (!this.check('RPAREN')) {
                    do {
                        args.push(this.parseExpression());
                    } while (this.match('SEMICOLON'));
                }
                this.consume('RPAREN', 'Expected )');
                return { type: 'function', name, args };
            }

            // No-arg function call (like `keys`, `length`)
            return { type: 'function', name, args: [] };
        }

        throw new Error(`Unexpected token: ${this.current().type} (${this.current().value})`);
    }

    // Array: [expr, expr, ...]
    private parseArray(): ASTNode {
        this.consume('LBRACKET', 'Expected [');

        const elements: ASTNode[] = [];

        if (!this.check('RBRACKET')) {
            do {
                elements.push(this.parseExpression());
            } while (this.match('COMMA'));
        }

        this.consume('RBRACKET', 'Expected ]');
        return { type: 'array', elements };
    }

    // Object: {key: val, ...}
    private parseObject(): ASTNode {
        this.consume('LBRACE', 'Expected {');

        const entries: ObjectEntry[] = [];

        if (!this.check('RBRACE')) {
            do {
                let key: string | ASTNode;

                // Computed key: (expr)
                if (this.match('LPAREN')) {
                    key = this.parseExpression();
                    this.consume('RPAREN', 'Expected )');
                }
                // String key
                else if (this.check('STRING')) {
                    key = String(this.tokens[this.position++].value);
                }
                // Identifier key
                else if (this.check('IDENT')) {
                    key = String(this.tokens[this.position++].value);
                }
                // Shorthand: {foo} means {foo: .foo}
                else if (this.check('DOT')) {
                    this.position++;
                    if (this.check('IDENT')) {
                        const name = String(this.tokens[this.position++].value);
                        entries.push({
                            key: name,
                            value: { type: 'field', name, optional: false }
                        });
                        continue;
                    }
                    throw new Error('Expected field name after .');
                }
                else {
                    throw new Error('Expected object key');
                }

                this.consume('COLON', 'Expected :');
                const value = this.parseExpression();
                entries.push({ key, value });

            } while (this.match('COMMA'));
        }

        this.consume('RBRACE', 'Expected }');
        return { type: 'object', entries };
    }
}
