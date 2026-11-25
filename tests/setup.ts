// Test-only secrets, used when the environment doesn't set its own. These
// never touch a deployed app.
process.env.BETTER_AUTH_SECRET ??= 'test-secret-'.padEnd(40, 'x')
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64url')
