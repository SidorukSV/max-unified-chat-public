import test from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = "VeryStrongJwtSecret!2026-AlphaBeta";
process.env.NODE_ENV = "test";
process.env.ONEC_CONFIG_FILE = "__max_webhook_test_missing.yml";
process.env.ONEC_CONFIG = JSON.stringify(
    {
        url: "https://onec.example/base",
        basicAuth: "basic-onec",
    }
);
process.env.MAX_WEBHOOK_SECRET = "secret-test";
process.env.MAX_BOT_ID = "bot-42";
process.env.MAX_WEBHOOK_FORWARD_TIMEOUT_MS = "1000";

const { buildApp } = await import("../src/app.js");

function createJsonResponse(status, payload, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return headers[name.toLowerCase()] ?? null;
            },
        },
        async json() {
            return payload;
        },
        async text() {
            return typeof payload === "string" ? payload : JSON.stringify(payload);
        },
    };
}

test("MAX webhook rejects requests when configured secret does not match", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;
    let fetchCalled = false;

    global.fetch = async () => {
        fetchCalled = true;
        return createJsonResponse(200, {});
    };

    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/max/webhook",
        payload: {
            update_type: "bot_started",
        },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "max_webhook_secret_invalid");
    assert.equal(fetchCalled, false);
});

test("MAX webhook forwards Update body to the configured 1C bot webhook", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        const call = {
            url,
            method: options.method || "GET",
            headers: new Headers(options.headers || {}),
            body: options.body || null,
        };
        calls.push(call);

        if (url === "https://onec.example/base/startIBSession") {
            return createJsonResponse(200, {}, {
                "set-cookie": "ibsession=max-test-cookie; Path=/; HttpOnly",
            });
        }

        if (url === "https://onec.example/base/webhook/bot-42") {
            return createJsonResponse(200, { success: true });
        }

        return createJsonResponse(404, { desc: "not_found" });
    };

    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const update = {
        update_type: "message_created",
        timestamp: 1710000000,
        chat_id: 123,
    };

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/max/webhook",
        headers: {
            "X-Max-Bot-Api-Secret": "secret-test",
        },
        payload: update,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);

    const webhookCall = calls.find((call) => call.url === "https://onec.example/base/webhook/bot-42");
    assert.ok(webhookCall);
    assert.equal(webhookCall.method, "POST");
    assert.equal(webhookCall.headers.get("Authorization"), "Basic basic-onec");
    assert.equal(webhookCall.headers.get("Content-Type"), "application/json");
    assert.equal(webhookCall.headers.get("Cookie"), "ibsession=max-test-cookie");
    assert.deepEqual(JSON.parse(webhookCall.body), update);
});

test("MAX webhook returns retryable error when 1C forwarding fails", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;

    global.fetch = async (url) => {
        if (url === "https://onec.example/base/startIBSession") {
            return createJsonResponse(200, {}, {
                "set-cookie": "ibsession=max-test-cookie-after-error; Path=/; HttpOnly",
            });
        }

        if (url === "https://onec.example/base/webhook/bot-42") {
            return createJsonResponse(500, { desc: "webhook_failed" });
        }

        return createJsonResponse(404, { desc: "not_found" });
    };

    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/max/webhook",
        headers: {
            "X-Max-Bot-Api-Secret": "secret-test",
        },
        payload: {
            update_type: "message_created",
        },
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error, "onec_webhook_forward_failed");
});
