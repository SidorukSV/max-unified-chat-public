import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://incoming-lease-test";
process.env.ONEC_API_KEY = "onec-test-key";
process.env.BACKEND_LOG_LEVEL = "silent";
const { buildApp } = await import("../src/app.js");
const {
    enqueueIncomingMaxUpdate, claimIncomingMaxUpdates, acknowledgeIncomingMaxUpdates,
    getIncomingQueueLength, incomingLeaseMs, messageQueueTestUtils,
} = await import("../src/services/messageQueue.js");

test("claim requires ACK, retries expired lease and rejects stale receipt", async () => {
    messageQueueTestUtils.resetMemoryQueues();
    const original = await enqueueIncomingMaxUpdate({ update_type: "message_callback" });
    const [first] = await claimIncomingMaxUpdates(1);
    assert.equal(first.id, original.id);
    assert.ok(first.receipt);
    assert.equal(await getIncomingQueueLength(), 0);
    assert.deepEqual(await claimIncomingMaxUpdates(1), []);
    assert.equal(await acknowledgeIncomingMaxUpdates([original.id, "invalid"]), 0);

    messageQueueTestUtils.advanceMemoryClock(incomingLeaseMs + 1);
    assert.equal(await acknowledgeIncomingMaxUpdates([first.receipt]), 0);
    const [retry] = await claimIncomingMaxUpdates(1);
    assert.equal(retry.id, first.id);
    assert.deepEqual(retry.update, original.update);
    assert.notEqual(retry.receipt, first.receipt);
    assert.equal(await acknowledgeIncomingMaxUpdates([first.receipt]), 0);
    assert.equal(await acknowledgeIncomingMaxUpdates([retry.receipt, retry.receipt]), 1);
    assert.equal(await acknowledgeIncomingMaxUpdates([retry.receipt]), 0);
    messageQueueTestUtils.advanceMemoryClock(incomingLeaseMs + 1);
    assert.deepEqual(await claimIncomingMaxUpdates(1), []);
});

test("parallel claims have unique receipts and poison data is retained in dead letter queue", async () => {
    messageQueueTestUtils.resetMemoryQueues();
    messageQueueTestUtils.enqueueMalformedMemoryValue("not json");
    messageQueueTestUtils.enqueueMalformedMemoryValue("{}");
    for (let index = 0; index < 20; index += 1) {
        await enqueueIncomingMaxUpdate({ update_type: "message_callback", index });
    }
    const batches = await Promise.all(Array.from({ length: 5 }, () => claimIncomingMaxUpdates(5)));
    const claims = batches.flat();
    assert.equal(claims.length, 20);
    assert.equal(new Set(claims.map((claim) => claim.id)).size, 20);
    assert.equal(new Set(claims.map((claim) => claim.receipt)).size, 20);
    assert.equal(messageQueueTestUtils.getMemoryDeadLetterCount(), 2);
    assert.equal(await acknowledgeIncomingMaxUpdates(claims.map((claim) => claim.receipt)), 20);
});

test("HTTP claim/ACK validates auth and lease mode, preserves backward compatibility", async (t) => {
    messageQueueTestUtils.resetMemoryQueues();
    const app = await buildApp();
    t.after(() => app.close());
    const headers = { "X-Onec-Api-Key": "onec-test-key" };
    const first = await enqueueIncomingMaxUpdate({ update_type: "message_created" });
    const invalidMode = await app.inject({
        method: "GET", url: "/api/v1/onec/messages/incoming?ack=yes", headers,
    });
    assert.equal(invalidMode.statusCode, 400);
    assert.equal(await getIncomingQueueLength(), 1);
    const claimed = await app.inject({
        method: "GET", url: "/api/v1/onec/messages/incoming?ack=true&limit=1", headers,
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().lease_ms, 120000);
    assert.equal(claimed.json().messages[0].id, first.id);
    const receipt = claimed.json().messages[0].receipt;
    const unauthorized = await app.inject({
        method: "POST", url: "/api/v1/onec/messages/incoming/ack", payload: { receipts: [receipt] },
    });
    assert.equal(unauthorized.statusCode, 401);
    for (const receipts of [[], "receipt", [12], [" "], Array(101).fill("receipt")]) {
        const invalid = await app.inject({
            method: "POST", url: "/api/v1/onec/messages/incoming/ack", headers, payload: { receipts },
        });
        assert.equal(invalid.statusCode, 400);
    }
    const ack = await app.inject({
        method: "POST", url: "/api/v1/onec/messages/incoming/ack", headers, payload: { receipts: [receipt] },
    });
    assert.deepEqual(ack.json(), { ok: true, acknowledged: 1 });
    const second = await enqueueIncomingMaxUpdate({ update_type: "bot_started" });
    const legacy = await app.inject({ method: "GET", url: "/api/v1/onec/messages/incoming", headers });
    assert.deepEqual(legacy.json(), { messages: [second], remaining: 0 });
});
