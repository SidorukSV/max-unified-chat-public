import test from "node:test";
import assert from "node:assert/strict";

async function createTestApp() {
    process.env.NODE_ENV = "test";
    process.env.REDIS_URL = "memory://security-headers-test";
    process.env.CORS_ALLOWED_ORIGINS = "https://chat.example.com";

    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    return app;
}

test("responses include baseline security headers", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "GET",
        url: "/__security_headers_probe__",
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "strict-origin-when-cross-origin");
    assert.match(response.headers["content-security-policy"] || "", /default-src 'self'/);
    assert.doesNotMatch(response.body, /<script>/i);
});
