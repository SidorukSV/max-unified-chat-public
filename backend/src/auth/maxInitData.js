import crypto from "node:crypto";

const WEBAPP_SECRET_KEY = "WebAppData";

function toComparableBuffer(value) {
    return Buffer.from(value, "utf8");
}

function safeCompareHex(leftHex, rightHex) {
    const left = toComparableBuffer(leftHex);
    const right = toComparableBuffer(rightHex);

    if (left.length !== right.length) {
        return false;
    }

    return crypto.timingSafeEqual(left, right);
}

function makeDataCheckString(params) {
    return Array.from(params.entries())
        .filter(([key]) => key !== "hash")
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");
}

function extractInitData(initDataRaw) {
    if (typeof initDataRaw !== "string" || !initDataRaw.trim()) {
        throw new Error("init_data_required");
    }

    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");

    if (!hash) {
        throw new Error("init_data_hash_required");
    }

    return { params, hash };
}

export function verifyMaxInitData(initDataRaw, { botToken, maxAgeSeconds = 300 } = {}) {
    if (!botToken) {
        throw new Error("max_bot_token_not_configured");
    }

    const { params, hash } = extractInitData(initDataRaw);
    const dataCheckString = makeDataCheckString(params);

    const secretKey = crypto
        .createHmac("sha256", WEBAPP_SECRET_KEY)
        .update(botToken)
        .digest();

    const computedHash = crypto
        .createHmac("sha256", secretKey)
        .update(dataCheckString)
        .digest("hex");

    if (!safeCompareHex(computedHash, hash)) {
        throw new Error("init_data_invalid_signature");
    }

    const authDateRaw = params.get("auth_date");
    const authDate = Number(authDateRaw);

    if (!Number.isFinite(authDate)) {
        throw new Error("init_data_invalid_auth_date");
    }

    const nowUnix = Math.floor(Date.now() / 1000);

    if (nowUnix - authDate > maxAgeSeconds) {
        throw new Error("init_data_expired");
    }

    let user = null;
    const userRaw = params.get("user");

    if (userRaw) {
        try {
            user = JSON.parse(userRaw);
        } catch {
            throw new Error("init_data_invalid_user_json");
        }
    }

    return {
        ok: true,
        authDate,
        queryId: params.get("query_id") || null,
        user,
    };
}
