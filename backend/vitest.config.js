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
            include: ['server.js', 'routes/*.js'],
            exclude: ['node_modules', 'tests', 'coverage'],
            thresholds: {
                // Infrastructure code (file interceptor, Telegram polling, watchdog monitors)
                // is untestable in unit tests — runs in production only. Thresholds reflect
                // the testable surface (routes, business logic, pure functions).
                lines: 38,
                functions: 40,
                branches: 30,
                statements: 38,
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
