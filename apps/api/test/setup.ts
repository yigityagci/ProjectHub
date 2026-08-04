// Loaded by Vitest (see vitest.config.ts `setupFiles`) BEFORE any test
// file's own imports run, so these process.env values are in place
// before src/config/env.ts parses process.env.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??=
  "postgresql://postgres:postgres@127.0.0.1:55432/projecthub_test";
process.env.REDIS_URL ??= "redis://127.0.0.1:56379";
process.env.APP_SECRET ??= "test-secret-value-not-for-production-use-1234567890";
process.env.APP_URL ??= "http://localhost:4000";
process.env.WEB_URL ??= "http://localhost:5173";
process.env.COOKIE_SECURE = "false";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.SESSION_TTL_HOURS ??= "24";
process.env.SESSION_ABSOLUTE_TTL_HOURS ??= "720";
process.env.INVITE_TTL_HOURS ??= "168";
// Fast argon2 params so the test suite runs quickly; production defaults
// (in .env.example) are much stronger.
process.env.ARGON2_MEMORY_COST_KIB ??= "8192";
process.env.ARGON2_TIME_COST ??= "2";
process.env.ARGON2_PARALLELISM ??= "1";
// A high default so ordinary tests (which register/log in many users
// across a single run against a shared Redis instance) never trip the
// login rate limiter. test/rate-limit.test.ts overrides this to a small
// number for its own isolated app instance via a dynamic import so it can
// exercise the 429 path deliberately.
process.env.RATE_LIMIT_LOGIN_MAX ??= "100000";
process.env.RATE_LIMIT_LOGIN_WINDOW_MINUTES ??= "15";
process.env.RATE_LIMIT_GLOBAL_MAX ??= "1000000";
process.env.RATE_LIMIT_GLOBAL_WINDOW_MINUTES ??= "1";
// Same rationale as RATE_LIMIT_LOGIN_MAX above: a high default so ordinary
// tests exercising the password-reset request endpoint repeatedly never
// trip its dedicated rate limiter.
process.env.RATE_LIMIT_PASSWORD_RESET_MAX ??= "100000";
process.env.RATE_LIMIT_PASSWORD_RESET_WINDOW_MINUTES ??= "15";
// Phase 4 uploads: a small limit keeps the oversized-upload test cheap (no
// need to allocate a real 25MB buffer), and a dedicated directory keeps
// test-run files out of the real dev `uploads/` folder.
process.env.UPLOAD_DIR ??= "uploads-test";
process.env.UPLOAD_MAX_SIZE_BYTES ??= String(1024 * 1024);
// The shared scheduler's interval must be far shorter than production's in
// tests, so tests can observe several ticks inside a normal assertion window.
// A tick with no registered handlers does no I/O, so a fast interval costs
// nothing across the ~30 test files that each build a server.
process.env.SCHEDULER_POLL_INTERVAL_MS ??= "50";
