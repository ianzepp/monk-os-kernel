/**
 * jq Types - Token and AST definitions
 *
 * Designed for extensibility - new node types and tokens can be added
 * without modifying existing code.
 */

// =============================================================================
// Token Types
// =============================================================================

export type TokenType =
    // Literals
    | 'DOT'           // .
    | 'NUMBER'        // 123, 1.5
    | 'STRING'        // "hello"
    | 'TRUE'          // true
    | 'FALSE'         // false
    | 'NULL'          // null
    | 'IDENT'         // identifier (field name or function)

    // Operators
    | 'PIPE'          // |
    | 'PLUS'          // +
    | 'MINUS'         // -
    | 'STAR'          // *
    | 'SLASH'         // /
    | 'PERCENT'       // %
    | 'EQ'            // ==
    | 'NE'            // !=
    | 'LT'            // <
    | 'LE'            // <=
    | 'GT'            // >
    | 'GE'            // >=
    | 'AND'           // and
    | 'OR'            // or
    | 'NOT'           // not
    | 'QUESTION'      // ?
    | 'COLON'         // :
    | 'SEMICOLON'     // ;
    | 'COMMA'         // ,
    | 'AS'            // as

    // Brackets
    | 'LBRACKET'      // [
    | 'RBRACKET'      // ]
    | 'LBRACE'        // {
    | 'RBRACE'        // }
    | 'LPAREN'        // (
    | 'RPAREN'        // )

    // Special
    | 'DOTDOT'        // .. (recursive descent)
    | 'EOF';

export interface Token {
    type: TokenType;
    value: string | number | null;
    position: number;
}

// =============================================================================
// AST Node Types
// =============================================================================

export type ASTNode =
    | IdentityNode
    | LiteralNode
    | FieldNode
    | IndexNode
    | SliceNode
    | IteratorNode
    | PipeNode
    | ArrayNode
    | ObjectNode
    | BinaryOpNode
    | UnaryOpNode
    | FunctionCallNode
    | ConditionalNode
    | TryCatchNode
    | RecursiveDescentNode
    | OptionalNode
    | VariableNode
    | VariableBindingNode;

// . (identity - returns input unchanged)
export interface IdentityNode {
    type: 'identity';
}

// Literal values: numbers, strings, booleans, null
export interface LiteralNode {
    type: 'literal';
    value: any;
}

// .field or .["field"]
export interface FieldNode {
    type: 'field';
    name: string;
    optional: boolean;  // .field? vs .field
}

// .[0] or .[-1]
export interface IndexNode {
    type: 'index';
    index: ASTNode;
    optional: boolean;
}

// .[2:5] or .[:-1]
export interface SliceNode {
    type: 'slice';
    start: ASTNode | null;
    end: ASTNode | null;
}

// .[] or .[]?
export interface IteratorNode {
    type: 'iterator';
    optional: boolean;
}

// expr | expr
export interface PipeNode {
    type: 'pipe';
    left: ASTNode;
    right: ASTNode;
}

// [expr, expr, ...]
export interface ArrayNode {
    type: 'array';
    elements: ASTNode[];
}

// {key: expr, ...} or {(expr): expr, ...}
export interface ObjectNode {
    type: 'object';
    entries: ObjectEntry[];
}

export interface ObjectEntry {
    key: ASTNode | string;  // string for literal keys, ASTNode for computed
    value: ASTNode;
}

// expr op expr
export interface BinaryOpNode {
    type: 'binary';
    operator: '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
    left: ASTNode;
    right: ASTNode;
}

// -expr or not expr
export interface UnaryOpNode {
    type: 'unary';
    operator: '-' | 'not';
    operand: ASTNode;
}

// func or func(args)
export interface FunctionCallNode {
    type: 'function';
    name: string;
    args: ASTNode[];
}

// if cond then expr else expr end
export interface ConditionalNode {
    type: 'conditional';
    condition: ASTNode;
    then: ASTNode;
    else: ASTNode | null;
}

// try expr catch expr
export interface TryCatchNode {
    type: 'try';
    expr: ASTNode;
    catch: ASTNode | null;
}

// .. (recursive descent)
export interface RecursiveDescentNode {
    type: 'recursive';
}

// expr? (optional - suppress errors)
export interface OptionalNode {
    type: 'optional';
    expr: ASTNode;
}

// $var
export interface VariableNode {
    type: 'variable';
    name: string;
}

// expr as $var | expr
export interface VariableBindingNode {
    type: 'binding';
    expr: ASTNode;
    variable: string;
    body: ASTNode;
}

// =============================================================================
// Evaluation Context
// =============================================================================

export interface JqContext {
    // Current input value
    input: any;
    // Variable bindings ($var)
    variables: Map<string, any>;
    // For streaming multiple outputs
    outputs: any[];
}

// =============================================================================
// Built-in Function Signature
// =============================================================================

export type BuiltinFn = (
    ctx: JqContext,
    args: ASTNode[],
    evaluate: (node: ASTNode, ctx: JqContext) => any[]
) => any[];

export interface BuiltinRegistry {
    [name: string]: BuiltinFn;
}
