import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://max-webhook-test";
process.env.MAX_WEBHOOK_SECRET = "secret-test";
process.env.ONEC_API_KEY = "onec-test-key";

const { buildApp } = await import("../src/app.js");
const { messageQueueTestUtils } = await import("../src/services/messageQueue.js");

test("MAX webhook rejects requests when configured secret does not match", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();

    t.after(async () => {
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
});

test("MAX webhook queues Update body for 1C polling", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();

    t.after(async () => {
        await app.close();
    });

    const update = {
        update_type: "message_created",
        timestamp: 1710000000,
        chat_id: 123,
        message: {
            body: {
                text: "hello",
            },
        },
    };

    const webhookResponse = await app.inject({
        method: "POST",
        url: "/api/v1/max/webhook",
        headers: {
            "X-Max-Bot-Api-Secret": "secret-test",
        },
        payload: update,
    });

    assert.equal(webhookResponse.statusCode, 200);
    assert.equal(webhookResponse.json().ok, true);
    assert.equal(webhookResponse.json().queued, true);
    assert.match(webhookResponse.json().message_id, /^[0-9a-f-]{36}$/i);

    const pollResponse = await app.inject({
        method: "GET",
        url: "/api/v1/onec/messages/incoming?limit=10",
        headers: {
            "X-Onec-Api-Key": "onec-test-key",
        },
    });

    assert.equal(pollResponse.statusCode, 200);
    assert.equal(pollResponse.json().messages.length, 1);
    assert.equal(pollResponse.json().messages[0].id, webhookResponse.json().message_id);
    assert.deepEqual(pollResponse.json().messages[0].update, update);
    assert.equal(pollResponse.json().remaining, 0);
});
