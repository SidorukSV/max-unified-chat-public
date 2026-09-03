import crypto from "crypto";
import { config } from "../config.js";
import { getRedisClient } from "../store/redisClient.js";

const memoryQueues = new Map();

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
    },
};
