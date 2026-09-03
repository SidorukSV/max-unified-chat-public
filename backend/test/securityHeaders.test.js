import test from "node:test";
import assert from "node:assert/strict";

const JWT_SECRET = "VeryStrongJwtSecret!2026-AlphaBeta";

async function createTestApp() {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = "test";
    process.env.REFRESH_COOKIE_SECURE = "true";
    process.env.REFRESH_COOKIE_SAMESITE = "none";
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
});

test("auth refresh errors do not reflect script payloads (xss regression)", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const xssPayload = "<script>alert('xss')</script>";

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refresh_token: xssPayload },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "refresh_token_required");
    assert.doesNotMatch(response.body, /<script>/i);
});

test("logout clears refresh cookie with secure attributes", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        payload: {},
    });

    assert.equal(response.statusCode, 400);
    const setCookie = response.headers["set-cookie"] || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=None/i);
    assert.match(setCookie, /Max-Age=0/i);
});

test("cookie refresh requires a trusted browser origin", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: {
            cookie: "refresh_token=aaa.bbb.ccc",
        },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, "csrf_origin_invalid");
});

test("explicit refresh token does not require browser origin", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: {
            cookie: "refresh_token=stale.cookie.value",
        },
        payload: {
            refresh_token: "aaa.bbb.ccc",
        },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "invalid_refresh_token");
});

test("cookie refresh accepts a configured browser origin", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        headers: {
            cookie: "refresh_token=aaa.bbb.ccc",
            origin: "https://chat.example.com",
        },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "invalid_refresh_token");
});
