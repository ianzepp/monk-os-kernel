/**
 * ESLint Configuration - Monk OS
 *
 * STYLE
 * =====
 * Stroustrup brace style with blank lines between blocks.
 * See ~/.claude/CLAUDE.md for full style guide.
 *
 * @module eslint-config
 */

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        plugins: {
            '@stylistic': stylistic,
        },
        rules: {
            // =================================================================
            // BRACE STYLE: Stroustrup
            // =================================================================

            // WHY: Stroustrup puts else/catch/finally on new line
            '@stylistic/brace-style': ['error', 'stroustrup', {
                allowSingleLine: false,
            }],

            // =================================================================
            // SPACING AND BLANK LINES
            // =================================================================

            // WHY: Blank line after blocks (if, for, while, try, class, function)
            '@stylistic/padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: 'block-like', next: '*' },
                { blankLine: 'always', prev: '*', next: 'return' },
                { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
                { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
            ],

            // WHY: No blank line at start/end of blocks
            '@stylistic/padded-blocks': ['error', 'never'],

            // =================================================================
            // INDENTATION AND WHITESPACE
            // =================================================================

            '@stylistic/indent': ['error', 4],
            '@stylistic/no-tabs': 'error',
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/eol-last': ['error', 'always'],
            '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],

            // =================================================================
            // BRACES AND BRACKETS
            // =================================================================

            // WHY: Always require braces for clarity
            'curly': ['error', 'all'],

            // Spacing inside braces
            '@stylistic/object-curly-spacing': ['error', 'always'],
            '@stylistic/array-bracket-spacing': ['error', 'never'],

            // =================================================================
            // SEMICOLONS AND COMMAS
            // =================================================================

            '@stylistic/semi': ['error', 'always'],
            '@stylistic/comma-dangle': ['error', 'always-multiline'],

            // =================================================================
            // ARROW FUNCTIONS
            // =================================================================

            '@stylistic/arrow-parens': ['error', 'as-needed'],

            // =================================================================
            // TYPESCRIPT SPECIFIC
            // =================================================================

            '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
            '@typescript-eslint/consistent-type-imports': ['error', {
                prefer: 'type-imports',
            }],

            // Allow unused vars prefixed with _
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],

            // HACK: Disable some rules that conflict with Monk OS patterns
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-empty-object-type': 'off',
        },
    },
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'build/**',
            '.git/**',
            'packages/**',
        ],
    },
);
