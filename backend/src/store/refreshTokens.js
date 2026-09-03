import { getRedisClient } from "./redisClient.js";

const REFRESH_TOKEN_PREFIX = "refresh_token:";
const USER_TOKENS_PREFIX = "refresh_user_tokens:";
const USER_DEVICE_TOKENS_PREFIX = "refresh_user_device_tokens:";

function getRefreshTokenKey(jti) {
    return `${REFRESH_TOKEN_PREFIX}${jti}`;
}

function getUserTokensKey(patientId) {
    return `${USER_TOKENS_PREFIX}${patientId}`;
}

function getUserDeviceTokensKey(patientId, deviceId) {
    return `${USER_DEVICE_TOKENS_PREFIX}${patientId}:${deviceId}`;
}

function getIndexKeys(data) {
    const keys = [];

    if (data?.patient_id) {
        keys.push(getUserTokensKey(data.patient_id));

        if (data.device_id) {
            keys.push(getUserDeviceTokensKey(data.patient_id, data.device_id));
        }
    }

    return keys;
}

function computeTtlSecondsFromEntries(entries) {
    const now = Date.now();
    let maxExpiresAt = 0;

    for (const expiresAt of Object.values(entries)) {
        if (typeof expiresAt === "number" && expiresAt > maxExpiresAt) {
            maxExpiresAt = expiresAt;
        }
    }

    if (!maxExpiresAt) {
        return 0;
    }

    return Math.max(1, Math.ceil((maxExpiresAt - now) / 1000));
}

async function readIndexMap(redis, key) {
    const payload = await redis.get(key);

    if (!payload) {
        return {};
    }

    try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed;
        }
    } catch {
        return {};
    }

    return {};
}

async function writeIndexMap(redis, key, map) {
    const ttlSeconds = computeTtlSecondsFromEntries(map);

    if (ttlSeconds <= 0) {
        await redis.del(key);
        return;
    }

    await redis.set(key, JSON.stringify(map), { EX: ttlSeconds });
}

async function upsertIndexEntry(redis, key, jti, expiresAt) {
    const map = await readIndexMap(redis, key);
    map[jti] = expiresAt;
    await writeIndexMap(redis, key, map);
}

async function removeIndexEntry(redis, key, jti) {
    const map = await readIndexMap(redis, key);

    if (!Object.prototype.hasOwnProperty.call(map, jti)) {
        return;
    }

    delete map[jti];
    await writeIndexMap(redis, key, map);
}

async function removeFromIndexes(redis, jti, data) {
    const keys = getIndexKeys(data);

    for (const key of keys) {
        await removeIndexEntry(redis, key, jti);
    }
}

export async function saveRefreshToken(jti, data) {
    const redis = await getRedisClient();
    const ttlSeconds = Math.max(1, Math.ceil((data.expiresAt - Date.now()) / 1000));

    await redis.set(getRefreshTokenKey(jti), JSON.stringify(data), {
        EX: ttlSeconds,
    });

    const indexKeys = getIndexKeys(data);
    for (const key of indexKeys) {
        await upsertIndexEntry(redis, key, jti, data.expiresAt);
    }
}

export async function getRefreshToken(jti) {
    const redis = await getRedisClient();
    const payload = await redis.get(getRefreshTokenKey(jti));

    if (!payload) return null;

    return JSON.parse(payload);
}

export async function deleteRefreshToken(jti) {
    const redis = await getRedisClient();
    const stored = await getRefreshToken(jti);

    if (stored) {
        await removeFromIndexes(redis, jti, stored);
    }

    await redis.del(getRefreshTokenKey(jti));
}

async function revokeByIndexKey(indexKey) {
    const redis = await getRedisClient();
    const indexMap = await readIndexMap(redis, indexKey);
    const jtis = Object.keys(indexMap);

    for (const jti of jtis) {
        await deleteRefreshToken(jti);
    }

    await redis.del(indexKey);

    return jtis.length;
}

export async function revokeUserRefreshTokens(patientId) {
    if (!patientId) {
        return 0;
    }

    return revokeByIndexKey(getUserTokensKey(patientId));
}

export async function revokeUserDeviceRefreshTokens(patientId, deviceId) {
    if (!patientId || !deviceId) {
        return 0;
    }

    return revokeByIndexKey(getUserDeviceTokensKey(patientId, deviceId));
}
