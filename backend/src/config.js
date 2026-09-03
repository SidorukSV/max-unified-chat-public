import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const MIN_JWT_SECRET_LENGTH = 32;
const oneCConfigLoadDiagnostics = [];

function addOneCConfigDiagnostic(entry) {
    oneCConfigLoadDiagnostics.push({
        event: entry.event,
        level: entry.level || "info",
        source: entry.source || "onec_config",
        ...entry,
    });
}

function loadPackageVersion() {
    try {
        const packagePath = path.resolve(process.cwd(), "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
        return String(packageJson?.version || "").trim() || "unknown";
    } catch {
        return "unknown";
    }
}

function validateJwtSecret(rawSecret) {
    const jwtSecret = typeof rawSecret === "string" ? rawSecret.trim() : "";

    if (!jwtSecret) {
        throw new Error(
            "JWT_SECRET is required. Set a non-empty secret in environment variables before starting the backend."
        );
    }

    if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
        throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long.`);
    }

    const hasUppercase = /[A-Z]/.test(jwtSecret);
    const hasLowercase = /[a-z]/.test(jwtSecret);
    const hasDigit = /[0-9]/.test(jwtSecret);
    const hasSpecial = /[^A-Za-z0-9]/.test(jwtSecret);
    const classesMatched = [hasUppercase, hasLowercase, hasDigit, hasSpecial].filter(Boolean).length;

    if (classesMatched < 3) {
        throw new Error("JWT_SECRET must include at least 3 of 4 character classes: uppercase, lowercase, digits, special symbols.");
    }

    return jwtSecret;
}

function pickOneCConfig(parsed, sourceLabel) {
    if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
            return null;
        }

        if (parsed.length > 1) {
            throw new Error(`${sourceLabel} must contain exactly one 1C config`);
        }

        return parsed[0];
    }

    return parsed;
}

function normalizeOneCConfig(parsed, sourceLabel) {
    const item = pickOneCConfig(parsed, sourceLabel);

    if (!item) {
        return null;
    }

    if (typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${sourceLabel} must be an object`);
    }

    const url = typeof item.url === "string" ? item.url.trim() : "";
    const basicAuth = typeof item.basicAuth === "string" ? item.basicAuth.trim() : "";
    const onecTotpSecret = typeof item.onecTotpSecret === "string" ? item.onecTotpSecret.trim() : "";

    if (!url) {
        throw new Error(`${sourceLabel}.url is required`);
    }

    if (!basicAuth) {
        throw new Error(`${sourceLabel}.basicAuth is required`);
    }

    return {
        url,
        basicAuth,
        onecTotpSecret,
    };
}

function buildSafeOneCConfigMeta(oneCConfig) {
    if (!oneCConfig) {
        return null;
    }

    let parsedUrl = null;

    try {
        parsedUrl = new URL(oneCConfig.url);
    } catch {
        parsedUrl = null;
    }

    return {
        hasUrl: Boolean(oneCConfig.url),
        urlOrigin: parsedUrl ? parsedUrl.origin : null,
        urlPathname: parsedUrl ? parsedUrl.pathname : null,
        hasBasicAuth: Boolean(oneCConfig.basicAuth),
        hasOnecTotpSecret: Boolean(oneCConfig.onecTotpSecret),
    };
}

function parseOneCConfigJson(rawOneCConfig) {
    let parsed;

    try {
        parsed = JSON.parse(rawOneCConfig);
    } catch {
        throw new Error("ONEC_CONFIG must be a valid JSON object");
    }

    return normalizeOneCConfig(parsed, "ONEC_CONFIG");
}

function parseYamlValue(rawValue) {
    const value = rawValue.trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }

    return value;
}

function parseOneCConfigYaml(rawYaml, sourceLabel) {
    const lines = rawYaml.split(/\r?\n/);
    const configs = [];
    let current = {};
    let hasListItems = false;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();

        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        if (trimmed.startsWith("-")) {
            hasListItems = true;

            if (current && Object.keys(current).length > 0) {
                configs.push(current);
            }

            current = {};
            const inlinePair = trimmed.slice(1).trim();

            if (!inlinePair) {
                continue;
            }

            const match = inlinePair.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
            if (!match) {
                throw new Error(`${sourceLabel} contains invalid YAML line: ${trimmed}`);
            }

            current[match[1]] = parseYamlValue(match[2]);
            continue;
        }

        const match = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!match) {
            throw new Error(`${sourceLabel} contains invalid YAML line: ${trimmed}`);
        }

        current[match[1]] = parseYamlValue(match[2]);
    }

    if (current && Object.keys(current).length > 0) {
        configs.push(current);
    }

    return normalizeOneCConfig(hasListItems ? configs : current, sourceLabel);
}

function loadOneCConfig() {
    const explicitPath = process.env.ONEC_CONFIG_FILE || "";
    const onecConfigPath = explicitPath || "onec-config.yml";
    const resolvedPath = path.resolve(process.cwd(), onecConfigPath);
    const fileExists = fs.existsSync(resolvedPath);

    addOneCConfigDiagnostic({
        event: "onec_config_file_checked",
        explicitPath: Boolean(explicitPath),
        configuredPath: onecConfigPath,
        resolvedPath,
        cwd: process.cwd(),
        exists: fileExists,
    });

    if (fileExists) {
        const fileContent = fs.readFileSync(resolvedPath, "utf-8");
        const parsedConfig = parseOneCConfigYaml(fileContent, `ONEC config file (${path.basename(resolvedPath)})`);

        addOneCConfigDiagnostic({
            event: "onec_config_loaded",
            sourceType: "file",
            configuredPath: onecConfigPath,
            resolvedPath,
            config: buildSafeOneCConfigMeta(parsedConfig),
        });

        return parsedConfig;
    }

    if (process.env.ONEC_CONFIG) {
        addOneCConfigDiagnostic({
            event: "onec_config_env_checked",
            envVar: "ONEC_CONFIG",
            present: true,
        });

        const parsedConfig = parseOneCConfigJson(process.env.ONEC_CONFIG);

        addOneCConfigDiagnostic({
            event: "onec_config_loaded",
            sourceType: "env",
            envVar: "ONEC_CONFIG",
            config: buildSafeOneCConfigMeta(parsedConfig),
        });

        return parsedConfig;
    }

    addOneCConfigDiagnostic({
        event: "onec_config_not_found",
        level: "warn",
        configuredPath: onecConfigPath,
        resolvedPath,
        cwd: process.cwd(),
        onecConfigEnvPresent: false,
    });

    return null;
}

function parseNonNegativeInteger(rawValue, fallback) {
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return Math.floor(parsed);
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

const loadedOneCConfig = loadOneCConfig();
const packageVersion = loadPackageVersion();

export { oneCConfigLoadDiagnostics };

export const config = {
    port: Number(process.env.PORT || 3000),
    nodeEnv: process.env.NODE_ENV || "development",
    appVersion: process.env.APP_VERSION || packageVersion,
    backendVersion: process.env.BACKEND_VERSION || packageVersion,
    gitCommit: process.env.GIT_COMMIT || "unknown",
    buildTime: process.env.BUILD_TIME || "unknown",
    backendLogFile: process.env.BACKEND_LOG_FILE || "",
    backendLogLevel: parseLogLevel(process.env.BACKEND_LOG_LEVEL),
    jwtSecret: validateJwtSecret(process.env.JWT_SECRET),
    maxBotToken: process.env.MAX_BOT_TOKEN || "",
    maxBotId: process.env.MAX_BOT_ID || "",
    maxInitDataMaxAgeSeconds: Number(process.env.MAX_INIT_DATA_MAX_AGE_SECONDS || 300),
    maxWebhookSecret: process.env.MAX_WEBHOOK_SECRET || "",
    maxWebhookForwardTimeoutMs: parsePositiveInteger(process.env.MAX_WEBHOOK_FORWARD_TIMEOUT_MS, 25000),
    redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
    redisConnectTimeoutMs: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
    oneCConfig: loadedOneCConfig,
    corsAllowedOrigins: parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS),
    logsInternalApiKey: process.env.LOGS_INTERNAL_API_KEY || "",
    logsRateLimitPerMinute: parsePositiveInteger(process.env.LOGS_RATE_LIMIT_PER_MINUTE, 30),
    refreshCookieName: process.env.REFRESH_COOKIE_NAME || "refresh_token",
    refreshCookieSameSite: process.env.REFRESH_COOKIE_SAMESITE || "lax",
    refreshCookieSecure: process.env.REFRESH_COOKIE_SECURE
        ? process.env.REFRESH_COOKIE_SECURE === "true"
        : (process.env.NODE_ENV === "production"),
    devTotpSecret: process.env.DEV_TOTP_SECRET || "",
    devTotpPeriodSeconds: parsePositiveInteger(process.env.DEV_TOTP_PERIOD_SECONDS, 30),
    devTotpWindow: parseNonNegativeInteger(process.env.DEV_TOTP_WINDOW, 1),
};
