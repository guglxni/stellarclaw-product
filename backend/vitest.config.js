import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // ── Test Organization ──
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules'],

        // ── Environment ──
        // Use Node.js environment for backend tests
        environment: 'node',

        // ── Globals ──
        globals: true,

        // ── Timeouts ──
        testTimeout: 10000,
        hookTimeout: 15000,

        // ── Coverage (v8 — native, no instrumentation) ──
        coverage: {
            provider: 'v8',
            reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
            reportsDirectory: './coverage',
            include: ['server.js', 'bifrost.js'],
            exclude: ['node_modules', 'tests', 'coverage'],
            thresholds: {
                // Ratchet these up as coverage improves.
                // Current: bifrost.js=100%, server.js=51%
                lines: 50,
                functions: 50,
                branches: 45,
                statements: 50,
            },
        },

        // ── Reporter ──
        reporters: ['verbose'],

        // ── Pool ──
        pool: 'forks',           // Isolate each test file in its own process
        forks: {
            singleFork: false,
        },

        // ── Setup files ──
        setupFiles: ['./tests/setup.js'],
    },
});
