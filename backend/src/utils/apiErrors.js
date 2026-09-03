const SAFE_ERROR_VALUE_TYPES = new Set(["string", "number", "boolean"]);

function buildSafeMeta(meta) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        return {};
    }

    const safeMeta = {};

    for (const [key, value] of Object.entries(meta)) {
        if (value === null || SAFE_ERROR_VALUE_TYPES.has(typeof value)) {
            safeMeta[key] = value;
        }
    }

    return safeMeta;
}

export function sendApiError(reply, statusCode, errorCode, meta = null) {
    return reply.code(statusCode).send({
        error: errorCode,
        ...buildSafeMeta(meta),
    });
}
