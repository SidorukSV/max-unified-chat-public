import { sendApiError } from "../utils/apiErrors.js";

const RATE_LIMIT_ERROR_CODE = "auth_rate_limited";
const AUTH_ATTEMPT_FAILED_ERROR_CODE = "auth_attempt_failed";

const DEFAULT_LIMIT_POLICY = {
    windowMs: 60_000,
    limit: 6,
    lockMs: 30_000,
    lockAfterFailures: 3,
};

const attemptsStore = new Map();
let nowProvider = () => Date.now();

function normalizeDimension(value) {
    if (typeof value !== "string") {
        return "unknown";
    }

    const normalized = value.trim().toLowerCase();
    return normalized || "unknown";
}

function getStoreKey(scope, dimension, value) {
    return `${scope}:${dimension}:${normalizeDimension(value)}`;
}

function getOrCreateEntry(key, now, windowMs) {
    const existing = attemptsStore.get(key);

    if (!existing || now - existing.windowStart >= windowMs) {
        const fresh = {
            windowStart: now,
            count: 0,
            consecutiveFailures: 0,
            lockedUntil: 0,
        };
        attemptsStore.set(key, fresh);
        return fresh;
    }

    return existing;
}

function evaluateLimit(key, policy) {
    const now = nowProvider();
    const entry = getOrCreateEntry(key, now, policy.windowMs);

    if (entry.lockedUntil > now) {
        return { limited: true, retryAfterMs: entry.lockedUntil - now };
    }

    if (entry.count >= policy.limit) {
        return { limited: true, retryAfterMs: policy.windowMs - (now - entry.windowStart) };
    }

    entry.count += 1;
    return { limited: false, retryAfterMs: 0 };
}

function recordAttemptResult(key, policy, success) {
    const now = nowProvider();
    const entry = getOrCreateEntry(key, now, policy.windowMs);

    if (success) {
        entry.consecutiveFailures = 0;
        return;
    }

    entry.consecutiveFailures += 1;

    if (entry.consecutiveFailures >= policy.lockAfterFailures) {
        entry.lockedUntil = now + policy.lockMs;
        entry.consecutiveFailures = 0;
    }
}

export function consumeAuthAttemptBudget({ scope, dimensions, policy = DEFAULT_LIMIT_POLICY }) {
    for (const [dimension, rawValue] of Object.entries(dimensions || {})) {
        const key = getStoreKey(scope, dimension, rawValue);
        const limitResult = evaluateLimit(key, policy);

        if (limitResult.limited) {
            return {
                limited: true,
                retryAfterSeconds: Math.max(1, Math.ceil(limitResult.retryAfterMs / 1000)),
            };
        }
    }

    return { limited: false, retryAfterSeconds: 0 };
}

export function recordAuthAttempt({ scope, dimensions, success, policy = DEFAULT_LIMIT_POLICY }) {
    for (const [dimension, rawValue] of Object.entries(dimensions || {})) {
        const key = getStoreKey(scope, dimension, rawValue);
        recordAttemptResult(key, policy, success);
    }
}

export function sendAuthRateLimit(reply, retryAfterSeconds) {
    reply.header("Retry-After", String(retryAfterSeconds));
    return sendApiError(reply, 429, RATE_LIMIT_ERROR_CODE);
}

export function sendUnifiedAuthFailure(reply) {
    return sendApiError(reply, 401, AUTH_ATTEMPT_FAILED_ERROR_CODE);
}

export const authAttemptGuardTestUtils = {
    reset() {
        attemptsStore.clear();
        nowProvider = () => Date.now();
    },
    setNowProvider(provider) {
        nowProvider = provider;
    },
};
