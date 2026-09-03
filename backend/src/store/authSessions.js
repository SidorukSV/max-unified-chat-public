import { randomUUID } from "crypto";
import ms from "ms";
import { getRedisClient } from "./redisClient.js";

const AUTH_SESSION_PREFIX = "auth_session:";
const SESSION_TTL_SECONDS = Math.ceil(ms("5m") / 1000);

function getAuthSessionKey(id) {
    return `${AUTH_SESSION_PREFIX}${id}`;
}

export async function createSession() {
    const id = `a_${randomUUID()}`;
    const session = {
        id,
        createdAt: Date.now(),
        expiresAt: Date.now() + ms("5m"),
    };

    const redis = await getRedisClient();

    await redis.set(getAuthSessionKey(id), JSON.stringify(session), {
        EX: SESSION_TTL_SECONDS,
    });

    return id;
}

export async function getSession(id) {
    const redis = await getRedisClient();
    const payload = await redis.get(getAuthSessionKey(id));

    if (!payload) return null;

    return JSON.parse(payload);
}

export async function updateSession(id, data) {
    const session = await getSession(id);
    if (!session) return null;

    const updatedSession = {
        ...session,
        ...data,
    };

    const redis = await getRedisClient();

    await redis.set(getAuthSessionKey(id), JSON.stringify(updatedSession), {
        EX: SESSION_TTL_SECONDS,
    });

    return updatedSession;
}

export async function deleteSession(id) {
    const redis = await getRedisClient();
    await redis.del(getAuthSessionKey(id));
}
