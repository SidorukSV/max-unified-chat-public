import crypto from "crypto";
import { config } from "../config.js";
import { getRedisClient } from "../store/redisClient.js";
import { acknowledgeIncomingScript, claimIncomingScript } from "./incomingQueueScripts.js";

const memoryQueues = new Map();
const memoryClaims = new Map();
let memoryClockOffset = 0;
export const incomingLeaseMs = 120000;

function durableQueueKeys() {
    const key = config.redisIncomingQueueKey;
    const keys = [key, `${key}:inflight`, `${key}:leases`, config.redisIncomingDeadLetterQueueKey];
    if (new Set(keys).size !== keys.length) throw new Error("incoming_queue_keys_must_differ");
    return keys;
}

function isMemoryQueueEnabled() {
    return String(config.redisUrl || "").startsWith("memory://");
}

function getMemoryQueue(key) {
    if (!memoryQueues.has(key)) {
        memoryQueues.set(key, []);
    }

    return memoryQueues.get(key);
}

function safeJsonParse(rawValue) {
    try {
        return JSON.parse(rawValue);
    } catch {
        return null;
    }
}

export function createIncomingEnvelope(update) {
    return {
        id: crypto.randomUUID(),
        received_at: new Date().toISOString(),
        source: "max_webhook",
        update_type: update?.update_type || null,
        update,
    };
}

export async function enqueueIncomingMaxUpdate(update) {
    const envelope = createIncomingEnvelope(update);
    const serialized = JSON.stringify(envelope);

    if (isMemoryQueueEnabled()) {
        getMemoryQueue(config.redisIncomingQueueKey).push(serialized);
        return envelope;
    }

    const redis = await getRedisClient();
    await redis.rpush(config.redisIncomingQueueKey, serialized);

    return envelope;
}

export async function popIncomingMaxUpdates(limit) {
    const messages = [];
    const redis = isMemoryQueueEnabled() ? null : await getRedisClient();

    for (let index = 0; index < limit; index += 1) {
        const rawValue = isMemoryQueueEnabled()
            ? (getMemoryQueue(config.redisIncomingQueueKey).shift() ?? null)
            : await redis.lpop(config.redisIncomingQueueKey);
        if (rawValue === null) {
            break;
        }

        const parsed = safeJsonParse(rawValue);
        if (parsed) {
            messages.push(parsed);
            continue;
        }

        if (isMemoryQueueEnabled()) {
            getMemoryQueue(config.redisIncomingDeadLetterQueueKey).push(rawValue);
        } else {
            await redis.rpush(config.redisIncomingDeadLetterQueueKey, rawValue);
        }
    }

    return messages;
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export async function popIncomingMaxUpdatesLongPoll(limit, waitMs) {
    const deadline = Date.now() + waitMs;

    do {
        const messages = await popIncomingMaxUpdates(limit);
        if (messages.length || Date.now() >= deadline) {
            return messages;
        }

        await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);

    return [];
}

function parseClaimedEnvelope(raw) {
    const envelope = safeJsonParse(raw);
    return envelope && typeof envelope.id === "string" && envelope.update
        && typeof envelope.update === "object" && !Array.isArray(envelope.update) ? envelope : null;
}

export async function claimIncomingMaxUpdates(limit) {
    const keys = durableQueueKeys();
    const prefix = crypto.randomUUID();
    if (isMemoryQueueEnabled()) {
        const now = Date.now() + memoryClockOffset;
        const queue = getMemoryQueue(keys[0]);
        const expired = [...memoryClaims.entries()]
            .filter(([, claim]) => claim.expires <= now).slice(0, 1000);
        for (const [receipt, claim] of expired.reverse()) {
            queue.unshift(claim.raw);
            memoryClaims.delete(receipt);
        }
        const messages = [];
        for (let index = 0; index < limit && queue.length; index += 1) {
            const raw = queue.shift();
            const envelope = parseClaimedEnvelope(raw);
            if (!envelope) {
                getMemoryQueue(keys[3]).push(raw);
                continue;
            }
            const receipt = `${prefix}:${index + 1}`;
            const expires = now + incomingLeaseMs;
            memoryClaims.set(receipt, { raw, expires });
            messages.push({ ...envelope, receipt, lease_expires_at: expires });
        }
        return messages;
    }

    const redis = await getRedisClient();
    const data = JSON.parse(await redis.send([
        "EVAL", claimIncomingScript, keys.length, ...keys, limit, incomingLeaseMs, prefix,
    ]));
    // Lua encodes an empty table as {}, not []. Keep the external API consistent.
    const claims = Array.isArray(data.claims) ? data.claims : [];
    return claims.map(({ raw, receipt, lease_expires_at }) => ({
        ...JSON.parse(raw), receipt, lease_expires_at,
    }));
}

export async function claimIncomingMaxUpdatesLongPoll(limit, waitMs) {
    const deadline = Date.now() + waitMs;
    do {
        const messages = await claimIncomingMaxUpdates(limit);
        if (messages.length || Date.now() >= deadline) return messages;
        await delay(Math.min(250, Math.max(0, deadline - Date.now())));
    } while (Date.now() < deadline);
    return [];
}

export async function acknowledgeIncomingMaxUpdates(receipts) {
    const keys = durableQueueKeys();
    if (isMemoryQueueEnabled()) {
        const now = Date.now() + memoryClockOffset;
        let acknowledged = 0;
        for (const receipt of receipts) {
            const claim = memoryClaims.get(receipt);
            if (claim && claim.expires > now) {
                memoryClaims.delete(receipt);
                acknowledged += 1;
            }
        }
        return acknowledged;
    }
    const redis = await getRedisClient();
    return redis.send(["EVAL", acknowledgeIncomingScript, keys.length, ...keys, ...receipts]);
}

export async function getIncomingQueueLength() {
    if (isMemoryQueueEnabled()) {
        return getMemoryQueue(config.redisIncomingQueueKey).length;
    }

    const redis = await getRedisClient();
    return redis.llen(config.redisIncomingQueueKey);
}

export const messageQueueTestUtils = {
    resetMemoryQueues() {
        memoryQueues.clear();
        memoryClaims.clear();
        memoryClockOffset = 0;
    },
    advanceMemoryClock(milliseconds) {
        memoryClockOffset += milliseconds;
    },
    enqueueMalformedMemoryValue(value) {
        getMemoryQueue(config.redisIncomingQueueKey).push(value);
    },
    getMemoryDeadLetterCount() {
        return getMemoryQueue(config.redisIncomingDeadLetterQueueKey).length;
    },
};
