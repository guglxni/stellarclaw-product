import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                // Node.js globals
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                // Node 18+ / Web-compatible globals available in Node 22
                fetch: 'readonly',
                AbortSignal: 'readonly',
                AbortController: 'readonly',
                crypto: 'readonly',
                URL: 'readonly',
                URLSearchParams: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
            'no-console': 'off',           // We use console.log for server logging
            'no-undef': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
            'eqeqeq': ['error', 'always'],
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-with': 'error',
            'no-throw-literal': 'error',
            'no-return-await': 'warn',
            'require-atomic-updates': 'off',  // Too many false positives with Express req/res
        },
    },
    {
        ignores: ['node_modules/', 'coverage/', 'tests/', 'vitest.config.js'],
    },
];
