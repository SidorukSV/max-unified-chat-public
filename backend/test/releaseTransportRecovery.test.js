import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.REDIS_URL = "memory://release-transport";
process.env.ONEC_API_KEY = "release-test-only";
process.env.MAX_BOT_TOKEN = "release-test-bot";
process.env.MAX_API_BASE_URL = "https://platform-api2.max.ru";
process.env.BACKEND_LOG_LEVEL = "silent";

const { buildApp } = await import("../src/app.js");
const { config } = await import("../src/config.js");
const queue = await import("../src/services/messageQueue.js");

test("outgoing result is correlated and never labels 2xx provider failure as delivered", async (t) => {
    const app = await buildApp();
    const saved = global.fetch;
    t.after(async () => { global.fetch = saved; await app.close(); });
    const cases = [
        [200, { message: { body: { mid: "actual-mid" } } }, "sent"],
        [200, { success: false, message: "provider echoed private data" }, "unknown"],
        [200, { ok: true }, "unknown"],
        [429, { message: "slow down" }, "not_sent"],
        [503, { message: "provider error" }, "unknown"],
        [null, null, "unknown"],
    ];
    for (const [status, body, delivery] of cases) {
        let calls = 0;
        global.fetch = async () => {
            calls += 1;
            if (status === null) throw new Error("connection lost after send");
            return new Response(JSON.stringify(body), { status });
        };
        const response = await app.inject({ method: "POST", url: "/api/v1/onec/messages/outgoing",
            headers: { "X-Onec-Api-Key": "release-test-only" },
            payload: { user_id: 12345, text: "Test", client_message_id: "persisted-attempt-uuid" } });
        const result = response.json();
        assert.equal(result.results.length, 1);
        assert.equal(result.results[0].client_message_id, "persisted-attempt-uuid");
        assert.equal(result.results[0].delivery_status, delivery);
        assert.equal(result.ok, delivery === "sent");
        assert.equal(result.sent, delivery === "sent" ? 1 : 0);
        assert.equal(response.statusCode, delivery === "sent" ? 200 : 207);
        assert.equal(calls, 1, "the transport must not retry an uncertain attempt");
        assert.ok(!response.body.includes("private data"));
    }
});

test("invalid or plaintext MAX endpoint fails before transmitting the token", async (t) => {
    const app = await buildApp();
    const savedFetch = global.fetch;
    const savedUrl = config.maxApiBaseUrl;
    t.after(async () => { global.fetch = savedFetch; config.maxApiBaseUrl = savedUrl; await app.close(); });
    global.fetch = async () => assert.fail("plaintext or credential-bearing URL must not be fetched");
    for (const url of ["http://platform-api2.max.ru", "ftp://platform-api2.max.ru", "https://user:password@platform-api2.max.ru", "invalid"]) {
        config.maxApiBaseUrl = url;
        const response = await app.inject({ method: "POST", url: "/api/v1/onec/messages/outgoing",
            headers: { "X-Onec-Api-Key": "release-test-only" }, payload: { user_id: 12345, text: "Test" } });
        assert.equal(response.json().results[0].delivery_status, "not_sent");
        assert.equal(response.json().sent, 0);
    }
});

test("lost ACK reclaims the same durable envelope and original MAX event key", async () => {
    queue.messageQueueTestUtils.resetMemoryQueues();
    const event = { update_type: "message_created", message: {
        sender: { user_id: 12345 }, body: { mid: "stable-max-mid", text: "Test" } } };
    const envelope = await queue.enqueueIncomingMaxUpdate(event);
    const [first] = await queue.claimIncomingMaxUpdates(1);
    queue.messageQueueTestUtils.advanceMemoryClock(queue.incomingLeaseMs + 1);
    const [second] = await queue.claimIncomingMaxUpdates(1);
    assert.equal(second.id, envelope.id);
    assert.equal(second.update.message.body.mid, first.update.message.body.mid);
    assert.notEqual(first.receipt, second.receipt);
    assert.equal(await queue.acknowledgeIncomingMaxUpdates([first.receipt]), 0);
    assert.equal(await queue.acknowledgeIncomingMaxUpdates([second.receipt]), 1);
    // The matching 1C inbox regression proves that this redelivery is ACKed without redoing business writes.
});
