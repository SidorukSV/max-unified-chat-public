import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://onec-exchange-test";
process.env.ONEC_API_KEY = "onec-test-key";
process.env.MAX_BOT_TOKEN = "max-token-test";
process.env.MAX_API_BASE_URL = "https://platform-api2.max.ru";

const { buildApp } = await import("../src/app.js");
const { messageQueueTestUtils } = await import("../src/services/messageQueue.js");

test("1C capability probe requires authorization and does not consume incoming events", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const { enqueueIncomingMaxUpdate, getIncomingQueueLength } = await import("../src/services/messageQueue.js");
    await enqueueIncomingMaxUpdate({ update_type: "message_callback" });
    const app = await buildApp();
    t.after(() => app.close());
    const unauthorized = await app.inject({ method: "GET", url: "/api/v1/onec/capabilities" });
    assert.equal(unauthorized.statusCode, 401);
    const supported = await app.inject({
        method: "GET", url: "/api/v1/onec/capabilities",
        headers: { "X-Onec-Api-Key": "onec-test-key" },
    });
    assert.equal(supported.statusCode, 200);
    assert.deepEqual(supported.json(), { incoming_ack: true, callback_answer: true });
    assert.equal(await getIncomingQueueLength(), 1);
});

test("1C incoming polling requires service API key", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();

    t.after(async () => {
        await app.close();
    });

    const response = await app.inject({
        method: "GET",
        url: "/api/v1/onec/messages/incoming",
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, "onec_api_key_invalid");
});

test("1C incoming polling supports bounded long polling", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();

    t.after(async () => {
        await app.close();
    });

    const startedAt = Date.now();
    const response = await app.inject({
        method: "GET",
        url: "/api/v1/onec/messages/incoming?limit=1&waitMs=25",
        headers: {
            "X-Onec-Api-Key": "onec-test-key",
        },
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
        messages: [],
        remaining: 0,
    });
    assert.ok(elapsedMs >= 20);
});

test("1C outgoing message endpoint sends restricted MAX /messages request", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        calls.push({
            url,
            method: options.method,
            headers: new Headers(options.headers),
            body: options.body,
        });

        return {
            ok: true,
            status: 200,
            statusText: "OK",
            async json() {
                return {
                    message: {
                        id: "max-message-1",
                    },
                };
            },
            async text() {
                return "";
            },
        };
    };

    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const response = await app.inject({
        method: "POST",
        url: "/api/v1/onec/messages/outgoing",
        headers: {
            Authorization: "Bearer onec-test-key",
        },
        payload: {
            client_message_id: "onec-1",
            user_id: 12345,
            text: "Здравствуйте",
            notify: true,
        },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://platform-api2.max.ru/messages?user_id=12345");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.get("Authorization"), "max-token-test");
    assert.equal(calls[0].headers.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0].body), {
        text: "Здравствуйте",
        notify: true,
    });
});

test("1C callback answers require authorization and a message", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;
    global.fetch = async () => { assert.fail("invalid requests must not reach MAX"); };
    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const unauthorized = await app.inject({
        method: "POST", url: "/api/v1/onec/callbacks/answer",
        payload: { callback_id: "callback-1", message: { text: "Confirmed" } },
    });
    assert.equal(unauthorized.statusCode, 401);

    for (const payload of [
        {}, { callback_id: " " }, { callback_id: 123, message: { text: "test" } },
        { callback_id: "callback-1", notification: "Obsolete notification" },
        { callback_id: "callback-1", message: [] },
        { callback_id: "callback-1", message: { unknown: "test" } },
    ]) {
        const response = await app.inject({
            method: "POST", url: "/api/v1/onec/callbacks/answer",
            headers: { "X-Onec-Api-Key": "onec-test-key" }, payload,
        });
        assert.equal(response.statusCode, 400);
    }
});

test("1C callback answer uses restricted MAX /answers without calling 1C", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    const response = await app.inject({
        method: "POST", url: "/api/v1/onec/callbacks/answer",
        headers: { Authorization: "Bearer onec-test-key" },
        payload: {
            callback_id: "callback&special=1", disable_link_preview: true,
            notification: "do not forward", url: "https://untrusted.example/", user_id: 777,
            message: { text: "Приём подтверждён", attachments: [], notify: false, unknown: "ignored" },
        },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, max_response: { success: true } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url,
        "https://platform-api2.max.ru/answers?callback_id=callback%26special%3D1&disable_link_preview=true");
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers.Authorization, "max-token-test");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
        message: { text: "Приём подтверждён", attachments: [], notify: false },
    });
});

test("1C callback answer reports both HTTP errors and MAX success:false", async (t) => {
    const app = await buildApp();
    const originalFetch = global.fetch;
    t.after(async () => {
        global.fetch = originalFetch;
        await app.close();
    });

    for (const upstream of [
        { ok: false, status: 429, json: async () => ({ message: "Rate limited" }) },
        { ok: true, status: 200, json: async () => ({ success: false, message: "Expired callback" }) },
    ]) {
        global.fetch = async () => upstream;
        const response = await app.inject({
            method: "POST", url: "/api/v1/onec/callbacks/answer",
            headers: { "X-Onec-Api-Key": "onec-test-key" },
            payload: { callback_id: "callback-1", message: { text: "Приём отменён" } },
        });
        assert.equal(response.statusCode, 502);
        assert.equal(response.json().error, "max_callback_answer_failed");
    }
});
