/**
 * AWK Interpreter
 *
 * Executes the AWK AST against input data.
 */

import type {
    ProgramNode, RuleNode, BlockNode, StmtNode, ExprNode,
    FunctionDefNode, PatternRangeNode, LValueNode,
    IfStmtNode, WhileStmtNode, DoWhileStmtNode, ForStmtNode,
    ForInStmtNode, PrintStmtNode, PrintfStmtNode,
    DeleteStmtNode, ExpressionStmtNode,
    BinaryNode, UnaryNode, TernaryNode, AssignmentNode,
    IncrementNode, FieldAccessNode, ArrayAccessNode,
    FunctionCallNode, GetlineNode, IdentifierNode,
    NumberLiteralNode, StringLiteralNode, RegexLiteralNode, InExprNode,
    AwkValue, RuntimeState,
} from './types.js';
import {
    BreakException, ContinueException, NextException, ExitException, ReturnException,
} from './types.js';
import { builtins, toNumber, toString, toBool, formatPrintf } from './builtins.js';

export type OutputWriter = (text: string) => void;

export class Interpreter {
    private program: ProgramNode;
    private state: RuntimeState;
    private stdout: OutputWriter;
    private stderr: OutputWriter;
    private signal?: AbortSignal;

    constructor(
        program: ProgramNode,
        stdout: OutputWriter,
        stderr: OutputWriter,
        signal?: AbortSignal
    ) {
        this.program = program;
        this.stdout = stdout;
        this.stderr = stderr;
        this.signal = signal;

        // Initialize runtime state
        this.state = {
            globals: {
                variables: new Map(),
                arrays: new Map(),
                parent: null,
            },
            builtins: {
                FS: ' ',
                RS: '\n',
                OFS: ' ',
                ORS: '\n',
                NR: 0,
                NF: 0,
                FNR: 0,
                FILENAME: '',
                SUBSEP: '\x1c',
                RSTART: 0,
                RLENGTH: 0,
                CONVFMT: '%.6g',
                OFMT: '%.6g',
            },
            fields: [''],
            functions: new Map(),
            exitCode: null,
            rangeStates: new Map(),
        };

        // Register user-defined functions
        for (const fn of program.functions) {
            this.state.functions.set(fn.name, fn);
        }
    }

    setFieldSeparator(fs: string): void {
        this.state.builtins.FS = fs;
    }

    setVariable(name: string, value: AwkValue): void {
        this.state.globals.variables.set(name, value);
    }

    async run(input: string): Promise<number> {
        try {
            // Run BEGIN blocks
            for (const block of this.program.begin) {
                if (this.signal?.aborted) return 130;
                await this.executeBlock(block);
                if (this.state.exitCode !== null) {
                    return this.state.exitCode;
                }
            }

            // Process input records
            const rs = this.state.builtins.RS;
            const records = rs === ''
                ? input.split(/\n\n+/)  // Paragraph mode
                : input.split(rs);

            // Remove trailing empty record if input ends with RS
            if (records.length > 0 && records[records.length - 1] === '') {
                records.pop();
            }

            for (const record of records) {
                if (this.signal?.aborted) return 130;
                if (this.state.exitCode !== null) break;

                this.state.builtins.NR++;
                this.state.builtins.FNR++;
                this.setRecord(record);

                try {
                    for (const rule of this.program.rules) {
                        if (this.signal?.aborted) return 130;
                        await this.executeRule(rule);
                    }
                } catch (e) {
                    if (e instanceof NextException) {
                        continue;
                    }
                    throw e;
                }
            }

            // Run END blocks
            for (const block of this.program.end) {
                if (this.signal?.aborted) return 130;
                await this.executeBlock(block);
            }

            return this.state.exitCode ?? 0;
        } catch (e) {
            if (e instanceof ExitException) {
                return e.code;
            }
            throw e;
        }
    }

    private setRecord(record: string): void {
        this.state.fields = [record];
        const fs = this.state.builtins.FS;

        let parts: string[];
        if (fs === ' ') {
            // Special: split on runs of whitespace, trim leading/trailing
            parts = record.trim().split(/\s+/);
            if (parts.length === 1 && parts[0] === '') {
                parts = [];
            }
        } else if (fs === '') {
            // Split into characters
            parts = record.split('');
        } else {
            try {
                parts = record.split(new RegExp(fs));
            } catch {
                parts = record.split(fs);
            }
        }

        this.state.fields.push(...parts);
        this.state.builtins.NF = parts.length;
    }

    private rebuildRecord(): void {
        // Rebuild $0 from fields
        const ofs = this.state.builtins.OFS;
        this.state.fields[0] = this.state.fields.slice(1).join(ofs);
    }

    private async executeRule(rule: RuleNode): Promise<void> {
        // Check pattern
        if (rule.pattern) {
            const matches = await this.evaluatePattern(rule, rule.pattern);
            if (!matches) return;
        }

        // Execute action (or default: print $0)
        if (rule.action) {
            await this.executeBlock(rule.action);
        } else {
            this.stdout(this.state.fields[0] + this.state.builtins.ORS);
        }
    }

    private async evaluatePattern(
        rule: RuleNode,
        pattern: ExprNode | PatternRangeNode
    ): Promise<boolean> {
        // Pattern range
        if (pattern.type === 'PatternRange') {
            const range = pattern as PatternRangeNode;
            const inRange = this.state.rangeStates.get(rule) ?? false;

            if (!inRange) {
                const startMatches = toBool(await this.evaluate(range.start));
                if (startMatches) {
                    this.state.rangeStates.set(rule, true);
                    return true;
                }
                return false;
            } else {
                const endMatches = toBool(await this.evaluate(range.end));
                if (endMatches) {
                    this.state.rangeStates.set(rule, false);
                }
                return true;
            }
        }

        // Regular expression pattern - match against $0
        if (pattern.type === 'RegexLiteral') {
            const regex = pattern as RegexLiteralNode;
            try {
                const re = new RegExp(regex.pattern, regex.flags);
                return re.test(this.state.fields[0]);
            } catch {
                return false;
            }
        }

        // Expression pattern
        return toBool(await this.evaluate(pattern));
    }

    private async executeBlock(block: BlockNode): Promise<void> {
        for (const stmt of block.statements) {
            if (this.signal?.aborted) throw new ExitException(130);
            await this.executeStatement(stmt);
        }
    }

    private async executeStatement(stmt: StmtNode): Promise<void> {
        switch (stmt.type) {
            case 'Block':
            case 'BeginBlock':
            case 'EndBlock':
                await this.executeBlock(stmt as BlockNode);
                break;

            case 'IfStmt':
                await this.executeIf(stmt as IfStmtNode);
                break;

            case 'WhileStmt':
                await this.executeWhile(stmt as WhileStmtNode);
                break;

            case 'DoWhileStmt':
                await this.executeDoWhile(stmt as DoWhileStmtNode);
                break;

            case 'ForStmt':
                await this.executeFor(stmt as ForStmtNode);
                break;

            case 'ForInStmt':
                await this.executeForIn(stmt as ForInStmtNode);
                break;

            case 'BreakStmt':
                throw new BreakException();

            case 'ContinueStmt':
                throw new ContinueException();

            case 'NextStmt':
                throw new NextException();

            case 'ExitStmt':
                const exitCode = stmt.code ? toNumber(await this.evaluate(stmt.code)) : 0;
                throw new ExitException(exitCode);

            case 'ReturnStmt':
                const returnValue = stmt.value ? await this.evaluate(stmt.value) : '';
                throw new ReturnException(returnValue);

            case 'DeleteStmt':
                await this.executeDelete(stmt as DeleteStmtNode);
                break;

            case 'PrintStmt':
                await this.executePrint(stmt as PrintStmtNode);
                break;

            case 'PrintfStmt':
                await this.executePrintf(stmt as PrintfStmtNode);
                break;

            case 'ExpressionStmt':
                await this.evaluate((stmt as ExpressionStmtNode).expression);
                break;
        }
    }

    private async executeIf(stmt: IfStmtNode): Promise<void> {
        const condition = toBool(await this.evaluate(stmt.condition));
        if (condition) {
            await this.executeStatement(stmt.consequent);
        } else if (stmt.alternate) {
            await this.executeStatement(stmt.alternate);
        }
    }

    private async executeWhile(stmt: WhileStmtNode): Promise<void> {
        while (toBool(await this.evaluate(stmt.condition))) {
            if (this.signal?.aborted) throw new ExitException(130);
            try {
                await this.executeStatement(stmt.body);
            } catch (e) {
                if (e instanceof BreakException) break;
                if (e instanceof ContinueException) continue;
                throw e;
            }
        }
    }

    private async executeDoWhile(stmt: DoWhileStmtNode): Promise<void> {
        do {
            if (this.signal?.aborted) throw new ExitException(130);
            try {
                await this.executeStatement(stmt.body);
            } catch (e) {
                if (e instanceof BreakException) break;
                if (e instanceof ContinueException) continue;
                throw e;
            }
        } while (toBool(await this.evaluate(stmt.condition)));
    }

    private async executeFor(stmt: ForStmtNode): Promise<void> {
        if (stmt.init) {
            await this.evaluate(stmt.init);
        }

        while (stmt.condition ? toBool(await this.evaluate(stmt.condition)) : true) {
            if (this.signal?.aborted) throw new ExitException(130);
            try {
                await this.executeStatement(stmt.body);
            } catch (e) {
                if (e instanceof BreakException) break;
                if (e instanceof ContinueException) {
                    if (stmt.update) await this.evaluate(stmt.update);
                    continue;
                }
                throw e;
            }
            if (stmt.update) {
                await this.evaluate(stmt.update);
            }
        }
    }

    private async executeForIn(stmt: ForInStmtNode): Promise<void> {
        const array = this.state.globals.arrays.get(stmt.array);
        if (!array) return;

        for (const key of array.keys()) {
            if (this.signal?.aborted) throw new ExitException(130);
            this.state.globals.variables.set(stmt.variable, key);
            try {
                await this.executeStatement(stmt.body);
            } catch (e) {
                if (e instanceof BreakException) break;
                if (e instanceof ContinueException) continue;
                throw e;
            }
        }
    }

    private async executeDelete(stmt: DeleteStmtNode): Promise<void> {
        const array = this.state.globals.arrays.get(stmt.array);
        if (!array) return;

        if (stmt.index === null) {
            // Delete entire array
            array.clear();
        } else {
            // Delete specific element
            const keys = await Promise.all(
                stmt.index.map(async (e) => toString(await this.evaluate(e)))
            );
            array.delete(keys.join(this.state.builtins.SUBSEP));
        }
    }

    private async executePrint(stmt: PrintStmtNode): Promise<void> {
        let output: string;

        if (stmt.args.length === 0) {
            output = this.state.fields[0];
        } else {
            const values = await Promise.all(stmt.args.map((a) => this.evaluate(a)));
            output = values.map((v) => toString(v)).join(this.state.builtins.OFS);
        }

        output += this.state.builtins.ORS;
        this.writeOutput(output, stmt.output);
    }

    private async executePrintf(stmt: PrintfStmtNode): Promise<void> {
        const format = toString(await this.evaluate(stmt.format));
        const args = await Promise.all(stmt.args.map((a) => this.evaluate(a)));
        const output = formatPrintf(format, args);
        this.writeOutput(output, stmt.output);
    }

    private writeOutput(text: string, redirect: PrintStmtNode['output']): void {
        // For now, all output goes to stdout
        // File/pipe redirects not implemented in virtual environment
        this.stdout(text);
    }

    private async evaluate(expr: ExprNode): Promise<AwkValue> {
        switch (expr.type) {
            case 'NumberLiteral':
                return (expr as NumberLiteralNode).value;

            case 'StringLiteral':
                return (expr as StringLiteralNode).value;

            case 'RegexLiteral': {
                // When used as expression, match against $0
                const regex = expr as RegexLiteralNode;
                try {
                    const re = new RegExp(regex.pattern, regex.flags);
                    return re.test(this.state.fields[0]) ? 1 : 0;
                } catch {
                    return 0;
                }
            }

            case 'Identifier':
                return this.getVariable((expr as IdentifierNode).name);

            case 'FieldAccess':
                return this.getField(expr as FieldAccessNode);

            case 'ArrayAccess':
                return await this.getArrayElement(expr as ArrayAccessNode);

            case 'Binary':
                return await this.evaluateBinary(expr as BinaryNode);

            case 'Unary':
                return await this.evaluateUnary(expr as UnaryNode);

            case 'Ternary':
                return await this.evaluateTernary(expr as TernaryNode);

            case 'Assignment':
                return await this.evaluateAssignment(expr as AssignmentNode);

            case 'Increment':
                return await this.evaluateIncrement(expr as IncrementNode);

            case 'FunctionCall':
                return await this.evaluateFunctionCall(expr as FunctionCallNode);

            case 'Getline':
                return await this.evaluateGetline(expr as GetlineNode);

            case 'InExpr':
                return this.evaluateIn(expr as InExprNode);

            default:
                return '';
        }
    }

    private getVariable(name: string): AwkValue {
        // Check built-in variables first
        if (name in this.state.builtins) {
            return this.state.builtins[name as keyof typeof this.state.builtins];
        }

        // Special case: `length` without parens is shorthand for length($0)
        if (name === 'length') {
            return this.state.fields[0]?.length ?? 0;
        }

        // User variable
        return this.state.globals.variables.get(name) ?? '';
    }

    private setVariableValue(name: string, value: AwkValue): void {
        // Check built-in variables
        if (name in this.state.builtins) {
            const builtins = this.state.builtins as Record<string, AwkValue>;
            builtins[name] = value;
            return;
        }

        this.state.globals.variables.set(name, value);
    }

    private async getField(expr: FieldAccessNode): Promise<AwkValue> {
        const idx = toNumber(await this.evaluate(expr.index));
        const index = Math.floor(idx);

        if (index < 0) return '';
        if (index >= this.state.fields.length) return '';

        return this.state.fields[index];
    }

    private async setField(index: number, value: AwkValue): Promise<void> {
        if (index < 0) return;

        // Extend fields array if needed
        while (this.state.fields.length <= index) {
            this.state.fields.push('');
        }

        this.state.fields[index] = toString(value);

        // Update NF if necessary
        if (index > this.state.builtins.NF) {
            this.state.builtins.NF = index;
        }

        // Rebuild $0 if we changed a field (not $0)
        if (index > 0) {
            this.rebuildRecord();
        } else {
            // Changed $0, re-split
            this.setRecord(toString(value));
        }
    }

    private async getArrayElement(expr: ArrayAccessNode): Promise<AwkValue> {
        let array = this.state.globals.arrays.get(expr.array);
        if (!array) {
            array = new Map();
            this.state.globals.arrays.set(expr.array, array);
        }

        const keys = await Promise.all(expr.indices.map((i) => this.evaluate(i)));
        const key = keys.map(toString).join(this.state.builtins.SUBSEP);

        return array.get(key) ?? '';
    }

    private async setArrayElement(
        arrayName: string,
        indices: ExprNode[],
        value: AwkValue
    ): Promise<void> {
        let array = this.state.globals.arrays.get(arrayName);
        if (!array) {
            array = new Map();
            this.state.globals.arrays.set(arrayName, array);
        }

        const keys = await Promise.all(indices.map((i) => this.evaluate(i)));
        const key = keys.map(toString).join(this.state.builtins.SUBSEP);

        array.set(key, value);
    }

    private async evaluateBinary(expr: BinaryNode): Promise<AwkValue> {
        const op = expr.operator;

        // Short-circuit operators
        if (op === '&&') {
            const left = toBool(await this.evaluate(expr.left));
            if (!left) return 0;
            return toBool(await this.evaluate(expr.right)) ? 1 : 0;
        }

        if (op === '||') {
            const left = toBool(await this.evaluate(expr.left));
            if (left) return 1;
            return toBool(await this.evaluate(expr.right)) ? 1 : 0;
        }

        const left = await this.evaluate(expr.left);
        const right = await this.evaluate(expr.right);

        // String concatenation
        if (op === ' ') {
            return toString(left) + toString(right);
        }

        // Regex match
        if (op === '~' || op === '!~') {
            const str = toString(left);
            let pattern: string;
            if (expr.right.type === 'RegexLiteral') {
                pattern = (expr.right as RegexLiteralNode).pattern;
            } else {
                pattern = toString(right);
            }

            try {
                const regex = new RegExp(pattern);
                const matches = regex.test(str);
                return (op === '~' ? matches : !matches) ? 1 : 0;
            } catch {
                return 0;
            }
        }

        // Comparison operators
        if (['==', '!=', '<', '<=', '>', '>='].includes(op)) {
            return this.compare(left, right, op) ? 1 : 0;
        }

        // Arithmetic operators
        const leftNum = toNumber(left);
        const rightNum = toNumber(right);

        switch (op) {
            case '+': return leftNum + rightNum;
            case '-': return leftNum - rightNum;
            case '*': return leftNum * rightNum;
            case '/': return rightNum === 0 ? 0 : leftNum / rightNum;
            case '%': return rightNum === 0 ? 0 : leftNum % rightNum;
            case '^': return Math.pow(leftNum, rightNum);
            default: return 0;
        }
    }

    private compare(left: AwkValue, right: AwkValue, op: string): boolean {
        // Both numbers: numeric comparison
        // Both strings: string comparison
        // Mixed: try numeric if both look numeric, else string

        const leftIsNum = typeof left === 'number' || /^-?\d+\.?\d*(e[+-]?\d+)?$/i.test(String(left));
        const rightIsNum = typeof right === 'number' || /^-?\d+\.?\d*(e[+-]?\d+)?$/i.test(String(right));

        if (leftIsNum && rightIsNum) {
            const l = toNumber(left);
            const r = toNumber(right);
            switch (op) {
                case '==': return l === r;
                case '!=': return l !== r;
                case '<': return l < r;
                case '<=': return l <= r;
                case '>': return l > r;
                case '>=': return l >= r;
            }
        }

        // String comparison
        const l = toString(left);
        const r = toString(right);
        switch (op) {
            case '==': return l === r;
            case '!=': return l !== r;
            case '<': return l < r;
            case '<=': return l <= r;
            case '>': return l > r;
            case '>=': return l >= r;
        }

        return false;
    }

    private async evaluateUnary(expr: UnaryNode): Promise<AwkValue> {
        const operand = await this.evaluate(expr.operand);

        switch (expr.operator) {
            case '!':
                return toBool(operand) ? 0 : 1;
            case '-':
                return -toNumber(operand);
            case '+':
                return toNumber(operand);
            default:
                return operand;
        }
    }

    private async evaluateTernary(expr: TernaryNode): Promise<AwkValue> {
        const condition = toBool(await this.evaluate(expr.condition));
        return condition
            ? await this.evaluate(expr.consequent)
            : await this.evaluate(expr.alternate);
    }

    private async evaluateAssignment(expr: AssignmentNode): Promise<AwkValue> {
        let value = await this.evaluate(expr.value);
        const target = expr.target;

        // Compound assignment
        if (expr.operator !== '=') {
            const current = await this.getLValue(target);
            const currentNum = toNumber(current);
            const valueNum = toNumber(value);

            switch (expr.operator) {
                case '+=': value = currentNum + valueNum; break;
                case '-=': value = currentNum - valueNum; break;
                case '*=': value = currentNum * valueNum; break;
                case '/=': value = valueNum === 0 ? 0 : currentNum / valueNum; break;
                case '%=': value = valueNum === 0 ? 0 : currentNum % valueNum; break;
                case '^=': value = Math.pow(currentNum, valueNum); break;
            }
        }

        await this.setLValue(target, value);
        return value;
    }

    private async getLValue(expr: LValueNode): Promise<AwkValue> {
        switch (expr.type) {
            case 'Identifier':
                return this.getVariable((expr as IdentifierNode).name);
            case 'FieldAccess':
                return await this.getField(expr as FieldAccessNode);
            case 'ArrayAccess':
                return await this.getArrayElement(expr as ArrayAccessNode);
        }
    }

    private async setLValue(expr: LValueNode, value: AwkValue): Promise<void> {
        switch (expr.type) {
            case 'Identifier':
                this.setVariableValue((expr as IdentifierNode).name, value);
                break;
            case 'FieldAccess': {
                const idx = toNumber(await this.evaluate((expr as FieldAccessNode).index));
                await this.setField(Math.floor(idx), value);
                break;
            }
            case 'ArrayAccess':
                await this.setArrayElement(
                    (expr as ArrayAccessNode).array,
                    (expr as ArrayAccessNode).indices,
                    value
                );
                break;
        }
    }

    private async evaluateIncrement(expr: IncrementNode): Promise<AwkValue> {
        const current = toNumber(await this.getLValue(expr.operand));
        const newValue = expr.operator === '++' ? current + 1 : current - 1;

        await this.setLValue(expr.operand, newValue);

        return expr.prefix ? newValue : current;
    }

    private async evaluateFunctionCall(expr: FunctionCallNode): Promise<AwkValue> {
        const args = await Promise.all(expr.args.map((a) => this.evaluate(a)));

        // Check built-in functions
        const builtin = builtins[expr.name];
        if (builtin) {
            return builtin(
                args,
                this.state,
                (name, value) => this.setVariableValue(name, value),
                (name, key, value) => {
                    let array = this.state.globals.arrays.get(name);
                    if (!array) {
                        array = new Map();
                        this.state.globals.arrays.set(name, array);
                    }
                    array.set(key, value);
                }
            );
        }

        // User-defined function
        const fn = this.state.functions.get(expr.name);
        if (!fn) {
            this.stderr(`awk: unknown function ${expr.name}\n`);
            return '';
        }

        return await this.callUserFunction(fn, args);
    }

    private async callUserFunction(fn: FunctionDefNode, args: AwkValue[]): Promise<AwkValue> {
        // Create new scope for function locals
        const savedVars = new Map(this.state.globals.variables);
        const savedArrays = new Map(this.state.globals.arrays);

        // Bind parameters
        for (let i = 0; i < fn.params.length; i++) {
            const value = i < args.length ? args[i] : '';
            this.state.globals.variables.set(fn.params[i], value);
        }

        try {
            await this.executeBlock(fn.body);
            return '';
        } catch (e) {
            if (e instanceof ReturnException) {
                return e.value;
            }
            throw e;
        } finally {
            // Restore scope
            this.state.globals.variables = savedVars;
            this.state.globals.arrays = savedArrays;
        }
    }

    private async evaluateGetline(_expr: GetlineNode): Promise<AwkValue> {
        // Not fully implemented - would need access to input stream
        return -1;
    }

    private evaluateIn(expr: InExprNode): AwkValue {
        const array = this.state.globals.arrays.get(expr.array);
        if (!array) return 0;

        // Synchronously evaluate indices for 'in' expression
        const keys = expr.index.map((e) => {
            if (e.type === 'StringLiteral') return (e as StringLiteralNode).value;
            if (e.type === 'NumberLiteral') return String((e as NumberLiteralNode).value);
            if (e.type === 'Identifier') return toString(this.getVariable((e as IdentifierNode).name));
            return '';
        });

        const key = keys.join(this.state.builtins.SUBSEP);
        return array.has(key) ? 1 : 0;
    }
}
