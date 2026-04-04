/**
 * Test setup — runs before every test file.
 *
 * Sets environment variables to safe defaults so that server.js
 * can be required without touching real services.
 */

process.env.NODE_ENV = 'test';
process.env.PORT = '0';   // 0 = random available port
process.env.DB_PATH = ':memory:';  // In-memory SQLite
process.env.DATABASE_URL = '';     // Force SQLite backend; dotenv won't override existing vars
process.env.PICOBOT_PATH = '/bin/true';  // Harmless binary
process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);  // 32 bytes hex
process.env.BIFROST_GATEWAY_URL = 'http://localhost:19999';  // Non-existent; mocked in tests
process.env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA'; // Cloudflare test key
process.env.DODO_PRODUCT_ID = 'pdt_test_standard';
process.env.DODO_CREDITS_PRODUCT_ID = 'pdt_credits_test';
process.env.DODO_API_KEY = 'test_dodo_api_key';
process.env.DODO_WEBHOOK_SECRET = 'test_dodo_webhook_secret';
process.env.TELEGRAM_MASTER_BOT_TOKEN = '000000000:AABBccddEEffGGhhIIjjKKllMMnnOOppQQr';
process.env.BOTS_DIR = '/tmp/liveclaw-test-bots';
process.env.WATCHDOG_INTERVAL_MS = '999999'; // Effectively disable watchdog in tests
process.env.ADMIN_SECRET = 'test-admin-secret';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.ALLOW_DEV_AUTH_BYPASS = '1';
