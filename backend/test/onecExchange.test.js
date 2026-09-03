import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://onec-exchange-test";
process.env.ONEC_API_KEY = "onec-test-key";
process.env.MAX_BOT_TOKEN = "max-token-test";
process.env.MAX_API_BASE_URL = "https://platform-api2.max.ru";

const { buildApp } = await import("../src/app.js");
const { messageQueueTestUtils } = await import("../src/services/messageQueue.js");

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
