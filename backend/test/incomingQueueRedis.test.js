import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Explicit opt-in. Never uses production-configured queue names, flushes Redis,
// starts containers, restarts Redis or calls MAX/1C.
test("Redis claim/ACK is atomic, survives client reconnect and retains failed deliveries", {
    skip: !process.env.REDIS_QUEUE_TEST_URL,
}, async (t) => {
    const prefix = `max:queue-regression:${crypto.randomUUID()}`;
    process.env.NODE_ENV = "test";
    process.env.REDIS_URL = process.env.REDIS_QUEUE_TEST_URL;
    process.env.REDIS_INCOMING_QUEUE_KEY = prefix;
    process.env.REDIS_INCOMING_DEAD_LETTER_QUEUE_KEY = `${prefix}:dead`;
    const { getRedisClient, closeRedisClient } = await import("../src/store/redisClient.js");
    const {
        enqueueIncomingMaxUpdate, claimIncomingMaxUpdates, acknowledgeIncomingMaxUpdates,
    } = await import("../src/services/messageQueue.js");
    const keys = [prefix, `${prefix}:inflight`, `${prefix}:leases`, `${prefix}:dead`];
    const redis = await getRedisClient();
    t.after(async () => {
        const cleanupClient = await getRedisClient();
        for (const key of keys) await cleanupClient.del(key);
        await closeRedisClient();
    });
    await redis.rpush(prefix, "malformed-json");
    for (let index = 0; index < 20; index += 1) {
        await enqueueIncomingMaxUpdate({ update_type: "message_callback", index });
    }
    const claims = (await Promise.all(Array.from({ length: 5 }, () => claimIncomingMaxUpdates(5)))).flat();
    assert.equal(claims.length, 20);
    assert.equal(new Set(claims.map((claim) => claim.id)).size, 20);
    assert.equal(await redis.llen(keys[3]), 1);
    assert.equal(await redis.llen(prefix), 0);
    assert.deepEqual(await claimIncomingMaxUpdates(5), []);

    await closeRedisClient();
    assert.deepEqual(await claimIncomingMaxUpdates(5), []);
    const reconnected = await getRedisClient();
    const first = claims.shift();
    // Expire only our own receipt; no real-time waits or global clock changes.
    await reconnected.send(["ZADD", keys[2], "0", first.receipt]);
    assert.equal(await acknowledgeIncomingMaxUpdates([first.receipt]), 0);
    const [retry] = await claimIncomingMaxUpdates(1);
    assert.equal(retry.id, first.id);
    assert.notEqual(retry.receipt, first.receipt);
    assert.equal(await acknowledgeIncomingMaxUpdates([first.receipt]), 0);
    assert.equal(await acknowledgeIncomingMaxUpdates([retry.receipt, retry.receipt]), 1);
    assert.equal(await acknowledgeIncomingMaxUpdates(claims.map((claim) => claim.receipt)), 19);
    assert.equal(await acknowledgeIncomingMaxUpdates([retry.receipt]), 0);
    assert.equal(await reconnected.send(["HLEN", keys[1]]), 0);
    assert.equal(await reconnected.send(["ZCARD", keys[2]]), 0);

    // Reject key-type misconfiguration before a script makes any queue mutation.
    await reconnected.set(keys[1], "wrong-type");
    await enqueueIncomingMaxUpdate({ update_type: "message_callback" });
    await assert.rejects(claimIncomingMaxUpdates(1), /incoming_queue_key_type_invalid/);
    assert.equal(await reconnected.llen(prefix), 1);
});
