/**
 * AWK Parser
 *
 * Parses tokens into an AST (Abstract Syntax Tree).
 */

import type {
    Token, TokenType, ProgramNode, RuleNode, FunctionDefNode,
    BlockNode, StmtNode, ExprNode, PatternRangeNode,
    IfStmtNode, WhileStmtNode, DoWhileStmtNode, ForStmtNode,
    ForInStmtNode, PrintStmtNode, PrintfStmtNode, OutputRedirect,
    DeleteStmtNode, ExpressionStmtNode, LValueNode,
    BinaryNode, UnaryNode, TernaryNode, AssignmentNode,
    IncrementNode, FieldAccessNode, ArrayAccessNode,
    FunctionCallNode, GetlineNode, IdentifierNode,
    NumberLiteralNode, StringLiteralNode, RegexLiteralNode, InExprNode,
} from './types.js';

export class Parser {
    private tokens: Token[];
    private pos: number = 0;

    constructor(tokens: Token[]) {
        this.tokens = tokens;
    }

    parse(): ProgramNode {
        const program: ProgramNode = {
            type: 'Program',
            begin: [],
            rules: [],
            end: [],
            functions: [],
        };

        this.skipNewlines();

        while (!this.isAtEnd()) {
            if (this.check('BEGIN')) {
                program.begin.push(this.beginBlock());
            } else if (this.check('END')) {
                program.end.push(this.endBlock());
            } else if (this.check('FUNCTION')) {
                program.functions.push(this.functionDef());
            } else {
                program.rules.push(this.rule());
            }
            this.skipNewlines();
        }

        return program;
    }

    private beginBlock(): BlockNode {
        const token = this.advance(); // BEGIN
        this.skipNewlines();
        const block = this.block();
        return { ...block, type: 'BeginBlock', line: token.line, column: token.column };
    }

    private endBlock(): BlockNode {
        const token = this.advance(); // END
        this.skipNewlines();
        const block = this.block();
        return { ...block, type: 'EndBlock', line: token.line, column: token.column };
    }

    private functionDef(): FunctionDefNode {
        const token = this.advance(); // function
        const name = this.consume('IDENTIFIER', 'Expected function name').value;

        this.consume('LPAREN', 'Expected ( after function name');
        const params: string[] = [];

        if (!this.check('RPAREN')) {
            do {
                params.push(this.consume('IDENTIFIER', 'Expected parameter name').value);
            } while (this.match('COMMA'));
        }

        this.consume('RPAREN', 'Expected ) after parameters');
        this.skipNewlines();
        const body = this.block();

        return {
            type: 'FunctionDef',
            name,
            params,
            body,
            line: token.line,
            column: token.column,
        };
    }

    private rule(): RuleNode {
        const token = this.peek();
        let pattern: ExprNode | PatternRangeNode | null = null;
        let action: BlockNode | null = null;

        // Check for pattern
        if (!this.check('LBRACE')) {
            pattern = this.pattern();
            this.skipNewlines();
        }

        // Check for action
        if (this.check('LBRACE')) {
            action = this.block();
        }

        // If no action, default is { print $0 }
        return {
            type: 'Rule',
            pattern,
            action,
            line: token.line,
            column: token.column,
        };
    }

    private pattern(): ExprNode | PatternRangeNode {
        const expr = this.expression();

        // Check for pattern range /start/,/end/
        if (this.match('COMMA')) {
            const end = this.expression();
            return {
                type: 'PatternRange',
                start: expr,
                end,
                line: expr.line,
                column: expr.column,
            };
        }

        return expr;
    }

    private block(): BlockNode {
        const token = this.consume('LBRACE', 'Expected {');
        this.skipNewlines();

        const statements: StmtNode[] = [];

        while (!this.check('RBRACE') && !this.isAtEnd()) {
            statements.push(this.statement());
            this.skipTerminators();
        }

        this.consume('RBRACE', 'Expected }');

        return {
            type: 'Block',
            statements,
            line: token.line,
            column: token.column,
        };
    }

    private statement(): StmtNode {
        if (this.check('LBRACE')) {
            return this.block();
        }

        if (this.check('IF')) {
            return this.ifStatement();
        }

        if (this.check('WHILE')) {
            return this.whileStatement();
        }

        if (this.check('DO')) {
            return this.doWhileStatement();
        }

        if (this.check('FOR')) {
            return this.forStatement();
        }

        if (this.check('BREAK')) {
            const token = this.advance();
            return { type: 'BreakStmt', line: token.line, column: token.column };
        }

        if (this.check('CONTINUE')) {
            const token = this.advance();
            return { type: 'ContinueStmt', line: token.line, column: token.column };
        }

        if (this.check('NEXT')) {
            const token = this.advance();
            return { type: 'NextStmt', line: token.line, column: token.column };
        }

        if (this.check('EXIT')) {
            return this.exitStatement();
        }

        if (this.check('RETURN')) {
            return this.returnStatement();
        }

        if (this.check('DELETE')) {
            return this.deleteStatement();
        }

        if (this.check('PRINT')) {
            return this.printStatement();
        }

        if (this.check('PRINTF')) {
            return this.printfStatement();
        }

        return this.expressionStatement();
    }

    private ifStatement(): IfStmtNode {
        const token = this.advance(); // if
        this.consume('LPAREN', 'Expected ( after if');
        const condition = this.expression();
        this.consume('RPAREN', 'Expected ) after condition');
        this.skipNewlines();

        const consequent = this.statement();
        let alternate: StmtNode | null = null;

        this.skipNewlines();
        if (this.match('ELSE')) {
            this.skipNewlines();
            alternate = this.statement();
        }

        return {
            type: 'IfStmt',
            condition,
            consequent,
            alternate,
            line: token.line,
            column: token.column,
        };
    }

    private whileStatement(): WhileStmtNode {
        const token = this.advance(); // while
        this.consume('LPAREN', 'Expected ( after while');
        const condition = this.expression();
        this.consume('RPAREN', 'Expected ) after condition');
        this.skipNewlines();

        const body = this.statement();

        return {
            type: 'WhileStmt',
            condition,
            body,
            line: token.line,
            column: token.column,
        };
    }

    private doWhileStatement(): DoWhileStmtNode {
        const token = this.advance(); // do
        this.skipNewlines();
        const body = this.statement();
        this.skipNewlines();

        this.consume('WHILE', 'Expected while after do body');
        this.consume('LPAREN', 'Expected ( after while');
        const condition = this.expression();
        this.consume('RPAREN', 'Expected ) after condition');

        return {
            type: 'DoWhileStmt',
            body,
            condition,
            line: token.line,
            column: token.column,
        };
    }

    private forStatement(): ForStmtNode | ForInStmtNode {
        const token = this.advance(); // for
        this.consume('LPAREN', 'Expected ( after for');

        // Check for for-in: for (var in array)
        if (this.check('IDENTIFIER')) {
            const varToken = this.peek();
            this.advance();

            if (this.match('IN')) {
                const array = this.consume('IDENTIFIER', 'Expected array name').value;
                this.consume('RPAREN', 'Expected ) after for-in');
                this.skipNewlines();
                const body = this.statement();

                return {
                    type: 'ForInStmt',
                    variable: varToken.value,
                    array,
                    body,
                    line: token.line,
                    column: token.column,
                };
            }

            // Not for-in, backtrack
            this.pos--;
        }

        // Regular for loop
        let init: ExprNode | null = null;
        if (!this.check('SEMICOLON')) {
            init = this.expression();
        }
        this.consume('SEMICOLON', 'Expected ; after for init');

        let condition: ExprNode | null = null;
        if (!this.check('SEMICOLON')) {
            condition = this.expression();
        }
        this.consume('SEMICOLON', 'Expected ; after for condition');

        let update: ExprNode | null = null;
        if (!this.check('RPAREN')) {
            update = this.expression();
        }
        this.consume('RPAREN', 'Expected ) after for');
        this.skipNewlines();

        const body = this.statement();

        return {
            type: 'ForStmt',
            init,
            condition,
            update,
            body,
            line: token.line,
            column: token.column,
        };
    }

    private exitStatement(): StmtNode {
        const token = this.advance(); // exit
        let code: ExprNode | null = null;

        if (!this.checkTerminator()) {
            code = this.expression();
        }

        return {
            type: 'ExitStmt',
            code,
            line: token.line,
            column: token.column,
        };
    }

    private returnStatement(): StmtNode {
        const token = this.advance(); // return
        let value: ExprNode | null = null;

        if (!this.checkTerminator()) {
            value = this.expression();
        }

        return {
            type: 'ReturnStmt',
            value,
            line: token.line,
            column: token.column,
        };
    }

    private deleteStatement(): DeleteStmtNode {
        const token = this.advance(); // delete
        const array = this.consume('IDENTIFIER', 'Expected array name').value;

        let index: ExprNode[] | null = null;
        if (this.match('LBRACKET')) {
            index = [this.expression()];
            while (this.match('COMMA')) {
                index.push(this.expression());
            }
            this.consume('RBRACKET', 'Expected ]');
        }

        return {
            type: 'DeleteStmt',
            array,
            index,
            line: token.line,
            column: token.column,
        };
    }

    private printStatement(): PrintStmtNode {
        const token = this.advance(); // print
        const args: ExprNode[] = [];
        let output: OutputRedirect | null = null;

        // Parse arguments until redirect or terminator
        while (!this.checkTerminator() && !this.check('GT') && !this.check('APPEND') && !this.check('PIPE')) {
            args.push(this.ternary());
            if (!this.match('COMMA')) break;
        }

        // Check for output redirect
        if (this.match('GT')) {
            output = { type: 'file', target: this.ternary() };
        } else if (this.match('APPEND')) {
            output = { type: 'append', target: this.ternary() };
        } else if (this.match('PIPE')) {
            output = { type: 'pipe', target: this.ternary() };
        }

        return {
            type: 'PrintStmt',
            args,
            output,
            line: token.line,
            column: token.column,
        };
    }

    private printfStatement(): PrintfStmtNode {
        const token = this.advance(); // printf
        const format = this.ternary();
        const args: ExprNode[] = [];
        let output: OutputRedirect | null = null;

        while (this.match('COMMA')) {
            if (this.check('GT') || this.check('APPEND') || this.check('PIPE')) break;
            args.push(this.ternary());
        }

        // Check for output redirect
        if (this.match('GT')) {
            output = { type: 'file', target: this.ternary() };
        } else if (this.match('APPEND')) {
            output = { type: 'append', target: this.ternary() };
        } else if (this.match('PIPE')) {
            output = { type: 'pipe', target: this.ternary() };
        }

        return {
            type: 'PrintfStmt',
            format,
            args,
            output,
            line: token.line,
            column: token.column,
        };
    }

    private expressionStatement(): ExpressionStmtNode {
        const expr = this.expression();
        return {
            type: 'ExpressionStmt',
            expression: expr,
            line: expr.line,
            column: expr.column,
        };
    }

    // Expression parsing with precedence climbing
    private expression(): ExprNode {
        return this.assignment();
    }

    private assignment(): ExprNode {
        const expr = this.ternary();

        if (this.match('ASSIGN', 'PLUS_ASSIGN', 'MINUS_ASSIGN', 'STAR_ASSIGN',
            'SLASH_ASSIGN', 'PERCENT_ASSIGN', 'CARET_ASSIGN')) {
            const operator = this.previous().value;
            const value = this.assignment();

            if (!this.isLValue(expr)) {
                throw new Error(`Invalid assignment target at line ${expr.line}`);
            }

            return {
                type: 'Assignment',
                operator,
                target: expr as LValueNode,
                value,
                line: expr.line,
                column: expr.column,
            };
        }

        return expr;
    }

    private ternary(): ExprNode {
        let expr = this.or();

        if (this.match('QUESTION')) {
            const consequent = this.ternary();
            this.consume('COLON', 'Expected : in ternary expression');
            const alternate = this.ternary();

            return {
                type: 'Ternary',
                condition: expr,
                consequent,
                alternate,
                line: expr.line,
                column: expr.column,
            };
        }

        return expr;
    }

    private or(): ExprNode {
        let left = this.and();

        while (this.match('OR')) {
            const operator = this.previous().value;
            const right = this.and();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private and(): ExprNode {
        let left = this.inExpr();

        while (this.match('AND')) {
            const operator = this.previous().value;
            const right = this.inExpr();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private inExpr(): ExprNode {
        let left = this.match_();

        // (index) in array
        if (this.match('IN')) {
            const array = this.consume('IDENTIFIER', 'Expected array name after in').value;

            // Left could be a single expression or parenthesized comma list
            let indices: ExprNode[];
            if (left.type === 'Binary' && left.operator === ',') {
                indices = this.flattenCommaExpr(left);
            } else {
                indices = [left];
            }

            return {
                type: 'InExpr',
                index: indices,
                array,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private flattenCommaExpr(expr: ExprNode): ExprNode[] {
        if (expr.type === 'Binary' && (expr as BinaryNode).operator === ',') {
            const bin = expr as BinaryNode;
            return [...this.flattenCommaExpr(bin.left), ...this.flattenCommaExpr(bin.right)];
        }
        return [expr];
    }

    private match_(): ExprNode {
        let left = this.comparison();

        while (this.match('MATCH', 'NOT_MATCH')) {
            const operator = this.previous().value;
            const right = this.comparison();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private comparison(): ExprNode {
        let left = this.concat();

        while (this.match('LT', 'LE', 'GT', 'GE', 'EQ', 'NE')) {
            const operator = this.previous().value;
            const right = this.concat();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private concat(): ExprNode {
        let left = this.addition();

        // String concatenation is implicit (space between expressions)
        // We detect it when two primaries are adjacent
        while (this.canStartExpr() && !this.check('COMMA') && !this.checkTerminator()) {
            // Check if next token could start an expression
            const right = this.addition();
            left = {
                type: 'Binary',
                operator: ' ',  // Concatenation
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private addition(): ExprNode {
        let left = this.multiplication();

        while (this.match('PLUS', 'MINUS')) {
            const operator = this.previous().value;
            const right = this.multiplication();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private multiplication(): ExprNode {
        let left = this.power();

        while (this.match('STAR', 'SLASH', 'PERCENT')) {
            const operator = this.previous().value;
            const right = this.power();
            left = {
                type: 'Binary',
                operator,
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private power(): ExprNode {
        let left = this.unary();

        // Right associative
        if (this.match('CARET')) {
            const right = this.power();
            return {
                type: 'Binary',
                operator: '^',
                left,
                right,
                line: left.line,
                column: left.column,
            };
        }

        return left;
    }

    private unary(): ExprNode {
        if (this.match('NOT', 'MINUS', 'PLUS')) {
            const operator = this.previous().value;
            const operand = this.unary();
            return {
                type: 'Unary',
                operator,
                operand,
                prefix: true,
                line: operand.line,
                column: operand.column,
            };
        }

        if (this.match('INCREMENT', 'DECREMENT')) {
            const operator = this.previous().value as '++' | '--';
            const operand = this.unary();

            if (!this.isLValue(operand)) {
                throw new Error(`Invalid increment/decrement target at line ${operand.line}`);
            }

            return {
                type: 'Increment',
                operator,
                operand: operand as LValueNode,
                prefix: true,
                line: operand.line,
                column: operand.column,
            };
        }

        return this.postfix();
    }

    private postfix(): ExprNode {
        let expr = this.primary();

        while (true) {
            if (this.match('INCREMENT', 'DECREMENT')) {
                const operator = this.previous().value as '++' | '--';

                if (!this.isLValue(expr)) {
                    throw new Error(`Invalid increment/decrement target at line ${expr.line}`);
                }

                expr = {
                    type: 'Increment',
                    operator,
                    operand: expr as LValueNode,
                    prefix: false,
                    line: expr.line,
                    column: expr.column,
                };
            } else if (this.match('LBRACKET')) {
                // Array subscript
                const indices: ExprNode[] = [this.expression()];
                while (this.match('COMMA')) {
                    indices.push(this.expression());
                }
                this.consume('RBRACKET', 'Expected ]');

                if (expr.type !== 'Identifier') {
                    throw new Error(`Expected array name at line ${expr.line}`);
                }

                expr = {
                    type: 'ArrayAccess',
                    array: (expr as IdentifierNode).name,
                    indices,
                    line: expr.line,
                    column: expr.column,
                };
            } else {
                break;
            }
        }

        return expr;
    }

    private primary(): ExprNode {
        const token = this.peek();

        // Number
        if (this.match('NUMBER')) {
            return {
                type: 'NumberLiteral',
                value: parseFloat(this.previous().value),
                line: token.line,
                column: token.column,
            };
        }

        // String
        if (this.match('STRING')) {
            return {
                type: 'StringLiteral',
                value: this.previous().value,
                line: token.line,
                column: token.column,
            };
        }

        // Regex
        if (this.match('REGEX')) {
            return {
                type: 'RegexLiteral',
                pattern: this.previous().value,
                flags: '',
                line: token.line,
                column: token.column,
            };
        }

        // Field reference
        if (this.match('FIELD')) {
            const field = this.previous().value;

            // $(...) - computed field
            if (field === '$' && this.match('LPAREN')) {
                const index = this.expression();
                this.consume('RPAREN', 'Expected )');
                return {
                    type: 'FieldAccess',
                    index,
                    line: token.line,
                    column: token.column,
                };
            }

            // $0, $1, $NF, $var
            const spec = field.slice(1);
            let index: ExprNode;

            if (/^\d+$/.test(spec)) {
                index = {
                    type: 'NumberLiteral',
                    value: parseInt(spec, 10),
                    line: token.line,
                    column: token.column,
                };
            } else {
                index = {
                    type: 'Identifier',
                    name: spec,
                    line: token.line,
                    column: token.column,
                };
            }

            return {
                type: 'FieldAccess',
                index,
                line: token.line,
                column: token.column,
            };
        }

        // Getline
        if (this.match('GETLINE')) {
            return this.getline(token);
        }

        // Identifier or function call
        if (this.match('IDENTIFIER')) {
            const name = this.previous().value;

            // Function call
            if (this.match('LPAREN')) {
                const args: ExprNode[] = [];

                if (!this.check('RPAREN')) {
                    do {
                        args.push(this.expression());
                    } while (this.match('COMMA'));
                }

                this.consume('RPAREN', 'Expected )');

                return {
                    type: 'FunctionCall',
                    name,
                    args,
                    line: token.line,
                    column: token.column,
                };
            }

            return {
                type: 'Identifier',
                name,
                line: token.line,
                column: token.column,
            };
        }

        // Parenthesized expression
        if (this.match('LPAREN')) {
            const expr = this.expression();
            this.consume('RPAREN', 'Expected )');
            return expr;
        }

        throw new Error(`Unexpected token '${token.value}' at line ${token.line}, column ${token.column}`);
    }

    private getline(token: Token): GetlineNode {
        let variable: string | null = null;
        let input: GetlineNode['input'] = null;

        // getline var
        if (this.check('IDENTIFIER') && !this.check('LT')) {
            variable = this.advance().value;
        }

        // getline < file
        if (this.match('LT')) {
            input = { type: 'file', source: this.primary() };
        }

        return {
            type: 'Getline',
            variable,
            input,
            line: token.line,
            column: token.column,
        };
    }

    private isLValue(expr: ExprNode): boolean {
        return expr.type === 'Identifier' ||
            expr.type === 'FieldAccess' ||
            expr.type === 'ArrayAccess';
    }

    private canStartExpr(): boolean {
        // Tokens that can start an expression
        const exprStarters: TokenType[] = [
            'NUMBER', 'STRING', 'REGEX', 'FIELD', 'IDENTIFIER',
            'LPAREN', 'NOT', 'MINUS', 'PLUS', 'INCREMENT', 'DECREMENT',
            'GETLINE',
        ];
        return exprStarters.includes(this.peek().type);
    }

    // Helper methods
    private match(...types: TokenType[]): boolean {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }

    private check(type: TokenType): boolean {
        if (this.isAtEnd()) return false;
        return this.peek().type === type;
    }

    private checkTerminator(): boolean {
        return this.check('NEWLINE') || this.check('SEMICOLON') ||
            this.check('RBRACE') || this.isAtEnd();
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.pos++;
        return this.previous();
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        const token = this.peek();
        throw new Error(`${message} at line ${token.line}, column ${token.column}`);
    }

    private peek(): Token {
        return this.tokens[this.pos];
    }

    private previous(): Token {
        return this.tokens[this.pos - 1];
    }

    private isAtEnd(): boolean {
        return this.peek().type === 'EOF';
    }

    private skipNewlines(): void {
        while (this.match('NEWLINE', 'SEMICOLON')) {
            // Skip
        }
    }

    private skipTerminators(): void {
        while (this.match('NEWLINE', 'SEMICOLON')) {
            // Skip
        }
    }
}
