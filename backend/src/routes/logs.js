import { config } from "../config.js";
import { authMiddleware } from "../middleware/auth.js";
import { sendApiError } from "../utils/apiErrors.js";

const REDACTED = "[REDACTED]";
const REDACTED_PHONE = "[REDACTED_PHONE]";
const REDACTED_TOKEN = "[REDACTED_TOKEN]";
const MAX_SANITIZE_DEPTH = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ENTRIES_LIMIT = 5_000;

const requestRateState = new Map();

const logRequestSchema = {
    body: {
        type: "object",
        additionalProperties: false,
        required: ["log"],
        properties: {
            log: {
                oneOf: [
                    {
                        type: "string",
                        minLength: 1,
                        maxLength: 4000,
                    },
                    {
                        type: "object",
                        maxProperties: 40,
                        additionalProperties: {
                            anyOf: [
                                { type: "string", maxLength: 500 },
                                { type: "number" },
                                { type: "boolean" },
                                { type: "null" },
                            ],
                        },
                    },
                ],
            },
            source: {
                type: "string",
                maxLength: 100,
            },
            level: {
                type: "string",
                enum: ["debug", "info", "warn", "error"],
            },
            context: {
                type: "object",
                maxProperties: 20,
                additionalProperties: {
                    anyOf: [
                        { type: "string", maxLength: 500 },
                        { type: "number" },
                        { type: "boolean" },
                        { type: "null" },
                    ],
                },
            },
        },
    },
};

const authDiagnosticSchema = {
    body: {
        type: "object",
        additionalProperties: false,
        required: ["event", "trace_id"],
        properties: {
            event: {
                type: "string",
                minLength: 1,
                maxLength: 80,
                pattern: "^[a-z0-9_]+$",
            },
            trace_id: {
                type: "string",
                minLength: 8,
                maxLength: 80,
                pattern: "^[A-Za-z0-9_-]+$",
            },
            level: {
                type: "string",
                enum: ["debug", "info", "warn", "error"],
            },
            details: {
                type: "object",
                maxProperties: 20,
                additionalProperties: {
                    anyOf: [
                        { type: "boolean" },
                        { type: "number" },
                        { type: "string", maxLength: 500 },
                        { type: "null" },
                    ],
                },
            },
        },
    },
};

function isInternalApiKeyValid(req) {
    const expectedInternalApiKey = config.logsInternalApiKey;
    if (!expectedInternalApiKey) {
        return false;
    }

    const providedApiKey = req.headers["x-internal-api-key"];
    if (typeof providedApiKey !== "string") {
        return false;
    }

    return providedApiKey === expectedInternalApiKey;
}

async function logsAccessMiddleware(req, reply) {
    const hasValidInternalApiKey = isInternalApiKeyValid(req);
    if (hasValidInternalApiKey) {
        req.logAuthType = "internal_api_key";
        return;
    }

    await authMiddleware(req, reply);

    if (!reply.sent) {
        req.logAuthType = "user_jwt";
    }
}

function cleanupRateLimitState(now) {
    if (requestRateState.size <= RATE_LIMIT_ENTRIES_LIMIT) {
        return;
    }

    for (const [key, state] of requestRateState) {
        if (now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
            requestRateState.delete(key);
        }

        if (requestRateState.size <= RATE_LIMIT_ENTRIES_LIMIT) {
            break;
        }
    }
}

async function logsRateLimitMiddleware(req, reply) {
    const now = Date.now();
    const key = req.ip || "unknown";
    const maxRequests = config.logsRateLimitPerMinute;

    cleanupRateLimitState(now);

    const state = requestRateState.get(key);
    if (!state || now - state.windowStart >= RATE_LIMIT_WINDOW_MS) {
        requestRateState.set(key, { windowStart: now, count: 1 });
        return;
    }

    if (state.count >= maxRequests) {
        return sendApiError(reply, 429, "rate_limit_exceeded");
    }

    state.count += 1;
}

function sanitizeString(value) {
    return value
        .replace(/(Bearer\s+)[A-Za-z0-9._\-=+/]+/gi, `$1${REDACTED_TOKEN}`)
        .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g, REDACTED_TOKEN)
        .replace(/(init_?data=)[^&\s]+/gi, `$1${REDACTED}`)
        .replace(/([?&](?:token|access_token|refresh_token|auth|authorization)=)[^&\s]+/gi, `$1${REDACTED_TOKEN}`)
        .replace(/\+?\d[\d()\-\s]{7,}\d/g, REDACTED_PHONE);
}

function sanitizeLogValue(value, depth = 0) {
    if (depth >= MAX_SANITIZE_DEPTH) {
        return "[TRUNCATED_DEPTH]";
    }

    if (typeof value === "string") {
        return sanitizeString(value);
    }

    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
    }

    if (!value || typeof value !== "object") {
        return value;
    }

    const sanitized = {};

    for (const [rawKey, rawValue] of Object.entries(value)) {
        const key = String(rawKey);
        if (/(token|authorization|phone|init_?data|secret|password|cookie|session|jwt)/i.test(key)) {
            sanitized[key] = REDACTED;
            continue;
        }

        sanitized[key] = sanitizeLogValue(rawValue, depth + 1);
    }

    return sanitized;
}

export async function logsRoutes(app) {
    app.post("/api/v1/auth/client-log",
        {
            preHandler: [logsRateLimitMiddleware],
            schema: authDiagnosticSchema,
        },
        async (req) => {
            const {
                event: diagnosticEvent,
                trace_id: traceId,
                level = "info",
                details = {},
            } = req.body;

            req.log[level](
                {
                    event: "auth_client_diagnostic",
                    diagnosticEvent,
                    traceId,
                    details: sanitizeLogValue(details),
                },
                "Pre-auth client diagnostic"
            );

            return { ok: true };
        });

    app.post("/api/v1/send-log",
        {
            preHandler: [logsAccessMiddleware, logsRateLimitMiddleware],
            schema: logRequestSchema,
        },
        async (req) => {
            const { log, source = "client", level = "info", context = null } = req.body;

            const sanitizedLog = sanitizeLogValue(log);
            const sanitizedContext = sanitizeLogValue(context);

            req.log[level](
                {
                    event: "client_log_received",
                    authType: req.logAuthType || "unknown",
                    source,
                    log: sanitizedLog,
                    context: sanitizedContext,
                },
                "Client log received"
            );

            return { ok: true };
        });
}
