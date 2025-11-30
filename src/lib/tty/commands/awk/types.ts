/**
 * AWK Type Definitions
 *
 * Types for tokens, AST nodes, and runtime values.
 */

// ============================================================================
// Token Types
// ============================================================================

export type TokenType =
    // Literals
    | 'NUMBER'
    | 'STRING'
    | 'REGEX'
    | 'IDENTIFIER'
    | 'FIELD'          // $0, $1, etc.
    // Keywords
    | 'BEGIN'
    | 'END'
    | 'IF'
    | 'ELSE'
    | 'WHILE'
    | 'FOR'
    | 'DO'
    | 'BREAK'
    | 'CONTINUE'
    | 'NEXT'
    | 'EXIT'
    | 'FUNCTION'
    | 'RETURN'
    | 'DELETE'
    | 'IN'
    | 'GETLINE'
    | 'PRINT'
    | 'PRINTF'
    // Operators
    | 'PLUS'           // +
    | 'MINUS'          // -
    | 'STAR'           // *
    | 'SLASH'          // /
    | 'PERCENT'        // %
    | 'CARET'          // ^
    | 'ASSIGN'         // =
    | 'PLUS_ASSIGN'    // +=
    | 'MINUS_ASSIGN'   // -=
    | 'STAR_ASSIGN'    // *=
    | 'SLASH_ASSIGN'   // /=
    | 'PERCENT_ASSIGN' // %=
    | 'CARET_ASSIGN'   // ^=
    | 'EQ'             // ==
    | 'NE'             // !=
    | 'LT'             // <
    | 'LE'             // <=
    | 'GT'             // >
    | 'GE'             // >=
    | 'MATCH'          // ~
    | 'NOT_MATCH'      // !~
    | 'AND'            // &&
    | 'OR'             // ||
    | 'NOT'            // !
    | 'QUESTION'       // ?
    | 'COLON'          // :
    | 'INCREMENT'      // ++
    | 'DECREMENT'      // --
    | 'CONCAT'         // (implicit, handled by parser)
    | 'APPEND'         // >>
    | 'PIPE'           // |
    // Delimiters
    | 'LPAREN'         // (
    | 'RPAREN'         // )
    | 'LBRACE'         // {
    | 'RBRACE'         // }
    | 'LBRACKET'       // [
    | 'RBRACKET'       // ]
    | 'COMMA'          // ,
    | 'SEMICOLON'      // ;
    | 'NEWLINE'
    // Special
    | 'EOF';

export type Token = {
    type: TokenType;
    value: string;
    line: number;
    column: number;
};

// ============================================================================
// AST Node Types
// ============================================================================

export type ASTNodeType =
    // Program structure
    | 'Program'
    | 'Rule'
    | 'BeginBlock'
    | 'EndBlock'
    | 'FunctionDef'
    // Patterns
    | 'PatternExpr'
    | 'PatternRange'
    // Statements
    | 'Block'
    | 'ExpressionStmt'
    | 'IfStmt'
    | 'WhileStmt'
    | 'DoWhileStmt'
    | 'ForStmt'
    | 'ForInStmt'
    | 'BreakStmt'
    | 'ContinueStmt'
    | 'NextStmt'
    | 'ExitStmt'
    | 'ReturnStmt'
    | 'DeleteStmt'
    | 'PrintStmt'
    | 'PrintfStmt'
    // Expressions
    | 'Binary'
    | 'Unary'
    | 'Ternary'
    | 'Assignment'
    | 'Increment'
    | 'FieldAccess'
    | 'ArrayAccess'
    | 'FunctionCall'
    | 'Getline'
    | 'Identifier'
    | 'NumberLiteral'
    | 'StringLiteral'
    | 'RegexLiteral'
    | 'InExpr';

// Base AST node
export type ASTNode = {
    type: ASTNodeType;
    line?: number;
    column?: number;
};

// Program
export type ProgramNode = ASTNode & {
    type: 'Program';
    begin: BlockNode[];
    rules: RuleNode[];
    end: BlockNode[];
    functions: FunctionDefNode[];
};

// Rule (pattern-action pair)
export type RuleNode = ASTNode & {
    type: 'Rule';
    pattern: ExprNode | PatternRangeNode | null;  // null = match all
    action: BlockNode | null;  // null = print $0
};

// Pattern range /start/,/end/
export type PatternRangeNode = ASTNode & {
    type: 'PatternRange';
    start: ExprNode;
    end: ExprNode;
};

// Function definition
export type FunctionDefNode = ASTNode & {
    type: 'FunctionDef';
    name: string;
    params: string[];
    body: BlockNode;
};

// Block { statements }
export type BlockNode = ASTNode & {
    type: 'Block' | 'BeginBlock' | 'EndBlock';
    statements: StmtNode[];
};

// Statements
export type IfStmtNode = ASTNode & {
    type: 'IfStmt';
    condition: ExprNode;
    consequent: StmtNode;
    alternate: StmtNode | null;
};

export type WhileStmtNode = ASTNode & {
    type: 'WhileStmt';
    condition: ExprNode;
    body: StmtNode;
};

export type DoWhileStmtNode = ASTNode & {
    type: 'DoWhileStmt';
    body: StmtNode;
    condition: ExprNode;
};

export type ForStmtNode = ASTNode & {
    type: 'ForStmt';
    init: ExprNode | null;
    condition: ExprNode | null;
    update: ExprNode | null;
    body: StmtNode;
};

export type ForInStmtNode = ASTNode & {
    type: 'ForInStmt';
    variable: string;
    array: string;
    body: StmtNode;
};

export type BreakStmtNode = ASTNode & { type: 'BreakStmt' };
export type ContinueStmtNode = ASTNode & { type: 'ContinueStmt' };
export type NextStmtNode = ASTNode & { type: 'NextStmt' };

export type ExitStmtNode = ASTNode & {
    type: 'ExitStmt';
    code: ExprNode | null;
};

export type ReturnStmtNode = ASTNode & {
    type: 'ReturnStmt';
    value: ExprNode | null;
};

export type DeleteStmtNode = ASTNode & {
    type: 'DeleteStmt';
    array: string;
    index: ExprNode[] | null;  // null = delete entire array
};

export type PrintStmtNode = ASTNode & {
    type: 'PrintStmt';
    args: ExprNode[];
    output: OutputRedirect | null;
};

export type PrintfStmtNode = ASTNode & {
    type: 'PrintfStmt';
    format: ExprNode;
    args: ExprNode[];
    output: OutputRedirect | null;
};

export type OutputRedirect = {
    type: 'file' | 'append' | 'pipe';
    target: ExprNode;
};

export type ExpressionStmtNode = ASTNode & {
    type: 'ExpressionStmt';
    expression: ExprNode;
};

export type StmtNode =
    | BlockNode
    | IfStmtNode
    | WhileStmtNode
    | DoWhileStmtNode
    | ForStmtNode
    | ForInStmtNode
    | BreakStmtNode
    | ContinueStmtNode
    | NextStmtNode
    | ExitStmtNode
    | ReturnStmtNode
    | DeleteStmtNode
    | PrintStmtNode
    | PrintfStmtNode
    | ExpressionStmtNode;

// Expressions
export type BinaryNode = ASTNode & {
    type: 'Binary';
    operator: string;
    left: ExprNode;
    right: ExprNode;
};

export type UnaryNode = ASTNode & {
    type: 'Unary';
    operator: string;
    operand: ExprNode;
    prefix: boolean;
};

export type TernaryNode = ASTNode & {
    type: 'Ternary';
    condition: ExprNode;
    consequent: ExprNode;
    alternate: ExprNode;
};

export type AssignmentNode = ASTNode & {
    type: 'Assignment';
    operator: string;  // =, +=, -=, etc.
    target: LValueNode;
    value: ExprNode;
};

export type IncrementNode = ASTNode & {
    type: 'Increment';
    operator: '++' | '--';
    operand: LValueNode;
    prefix: boolean;
};

export type FieldAccessNode = ASTNode & {
    type: 'FieldAccess';
    index: ExprNode;
};

export type ArrayAccessNode = ASTNode & {
    type: 'ArrayAccess';
    array: string;
    indices: ExprNode[];
};

export type FunctionCallNode = ASTNode & {
    type: 'FunctionCall';
    name: string;
    args: ExprNode[];
};

export type GetlineNode = ASTNode & {
    type: 'Getline';
    variable: string | null;
    input: InputSource | null;
};

export type InputSource = {
    type: 'file' | 'pipe';
    source: ExprNode;
};

export type IdentifierNode = ASTNode & {
    type: 'Identifier';
    name: string;
};

export type NumberLiteralNode = ASTNode & {
    type: 'NumberLiteral';
    value: number;
};

export type StringLiteralNode = ASTNode & {
    type: 'StringLiteral';
    value: string;
};

export type RegexLiteralNode = ASTNode & {
    type: 'RegexLiteral';
    pattern: string;
    flags: string;
};

export type InExprNode = ASTNode & {
    type: 'InExpr';
    index: ExprNode[];
    array: string;
};

// L-values (things that can be assigned to)
export type LValueNode = IdentifierNode | FieldAccessNode | ArrayAccessNode;

export type ExprNode =
    | BinaryNode
    | UnaryNode
    | TernaryNode
    | AssignmentNode
    | IncrementNode
    | FieldAccessNode
    | ArrayAccessNode
    | FunctionCallNode
    | GetlineNode
    | IdentifierNode
    | NumberLiteralNode
    | StringLiteralNode
    | RegexLiteralNode
    | InExprNode;

// ============================================================================
// Runtime Types
// ============================================================================

// AWK value (string or number, coerced as needed)
export type AwkValue = string | number;

// Array type (associative array keyed by string)
export type AwkArray = Map<string, AwkValue>;

// Variable scope
export type Scope = {
    variables: Map<string, AwkValue>;
    arrays: Map<string, AwkArray>;
    parent: Scope | null;
};

// Built-in variables
export type BuiltinVars = {
    FS: string;      // Field separator (default: " ")
    RS: string;      // Record separator (default: "\n")
    OFS: string;     // Output field separator (default: " ")
    ORS: string;     // Output record separator (default: "\n")
    NR: number;      // Number of records read
    NF: number;      // Number of fields in current record
    FNR: number;     // Record number in current file
    FILENAME: string; // Current filename
    SUBSEP: string;  // Array subscript separator (default: "\034")
    RSTART: number;  // Start of match (from match())
    RLENGTH: number; // Length of match (from match())
    CONVFMT: string; // Number to string conversion format
    OFMT: string;    // Output format for numbers
};

// Runtime state
export type RuntimeState = {
    globals: Scope;
    builtins: BuiltinVars;
    fields: string[];       // Current record fields ($0, $1, ...)
    functions: Map<string, FunctionDefNode>;
    exitCode: number | null;
    rangeStates: Map<RuleNode, boolean>;  // Track pattern range state
};

// Control flow exceptions
export class BreakException extends Error {
    constructor() { super('break'); this.name = 'BreakException'; }
}

export class ContinueException extends Error {
    constructor() { super('continue'); this.name = 'ContinueException'; }
}

export class NextException extends Error {
    constructor() { super('next'); this.name = 'NextException'; }
}

export class ExitException extends Error {
    code: number;
    constructor(code: number = 0) {
        super('exit');
        this.name = 'ExitException';
        this.code = code;
    }
}

export class ReturnException extends Error {
    value: AwkValue;
    constructor(value: AwkValue = '') {
        super('return');
        this.name = 'ReturnException';
        this.value = value;
    }
}
