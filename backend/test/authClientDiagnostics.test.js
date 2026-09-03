import test from "node:test";
import assert from "node:assert/strict";

const JWT_SECRET = "VeryStrongJwtSecret!2026-AlphaBeta";

async function createTestApp() {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.NODE_ENV = "test";

    const { buildApp } = await import("../src/app.js");
    return buildApp();
}

test("pre-auth client diagnostics accept a safe event without JWT", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/client-log",
        payload: {
            event: "contact_request_started",
            trace_id: "auth-trace-12345678",
            level: "info",
            details: {
                platform: "android",
                launchDataPresent: true,
            },
        },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
});

test("pre-auth client diagnostics reject unexpected nested data", async (t) => {
    const app = await createTestApp();
    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/client-log",
        payload: {
            event: "contact_request_started",
            trace_id: "auth-trace-12345678",
            details: {
                rawBridgeResponse: {
                    phone: "+79990001122",
                },
            },
        },
    });

    assert.equal(response.statusCode, 400);
});
