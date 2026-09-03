import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

function loadPackageVersion() {
    try {
        const packagePath = path.resolve(process.cwd(), "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
        return String(packageJson?.version || "").trim() || "unknown";
    } catch {
        return "unknown";
    }
}

function parsePositiveInteger(rawValue, fallback) {
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.floor(parsed);
}

function parseCorsAllowedOrigins(rawValue) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
        return [];
    }

    return Array.from(
        new Set(
            rawValue
                .split(",")
                .map((origin) => origin.trim())
                .filter(Boolean)
        )
    );
}

function parseLogLevel(rawValue) {
    const value = String(rawValue || "info").trim().toLowerCase();
    const allowed = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
    return allowed.has(value) ? value : "info";
}

const packageVersion = loadPackageVersion();

export const config = {
    port: Number(process.env.PORT || 3000),
    nodeEnv: process.env.NODE_ENV || "development",
    appVersion: process.env.APP_VERSION || packageVersion,
    backendVersion: process.env.BACKEND_VERSION || packageVersion,
    gitCommit: process.env.GIT_COMMIT || "unknown",
    buildTime: process.env.BUILD_TIME || "unknown",
    backendLogFile: process.env.BACKEND_LOG_FILE || "",
    backendLogLevel: parseLogLevel(process.env.BACKEND_LOG_LEVEL),
    corsAllowedOrigins: parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),

    maxApiBaseUrl: process.env.MAX_API_BASE_URL || "https://platform-api2.max.ru",
    maxBotToken: process.env.MAX_BOT_TOKEN || "",
    maxWebhookSecret: process.env.MAX_WEBHOOK_SECRET || "",
    maxRequestTimeoutMs: parsePositiveInteger(process.env.MAX_REQUEST_TIMEOUT_MS, 25000),

    onecApiKey: process.env.ONEC_API_KEY || "",
    onecPollDefaultLimit: parsePositiveInteger(process.env.ONEC_POLL_DEFAULT_LIMIT, 50),
    onecPollMaxLimit: parsePositiveInteger(process.env.ONEC_POLL_MAX_LIMIT, 100),

    redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    redisConnectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    redisIncomingQueueKey: process.env.REDIS_INCOMING_QUEUE_KEY || "max:incoming",
    redisIncomingDeadLetterQueueKey: process.env.REDIS_INCOMING_DEAD_LETTER_QUEUE_KEY || "max:incoming:dead",
};
