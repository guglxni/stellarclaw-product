import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // ── Test Organization ──
        include: ['tests/**/*.test.js'],
        exclude: ['node_modules'],

        // ── Environment ──
        // Use Node.js environment for backend tests
        environment: 'node',
        // Prevent dotenv from loading DATABASE_URL; tests must use SQLite
        env: {
            DATABASE_URL: '',
        },

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
            include: ['server.js', 'bifrost.js', 'routes/*.js'],
            exclude: ['node_modules', 'tests', 'coverage'],
            thresholds: {
                // Ratchet up as coverage improves.
                lines: 45,
                functions: 49,
                branches: 36,
                statements: 44,
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
