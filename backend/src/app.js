import fs from "fs";
import path from "path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { maxWebhookRoutes } from "./routes/maxWebhook.js";
import { onecExchangeRoutes } from "./routes/onecExchange.js";
import { versionRoutes } from "./routes/version.js";

function buildLoggerOptions() {
    const loggerOptions = {
        level: config.backendLogLevel,
    };

    if (!config.backendLogFile) {
        return loggerOptions;
    }

    const resolvedLogFile = path.resolve(process.cwd(), config.backendLogFile);
    fs.mkdirSync(path.dirname(resolvedLogFile), { recursive: true });

    return {
        ...loggerOptions,
        file: resolvedLogFile,
    };
}

export async function buildApp() {
    const localhostOrigins = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ];
    const isDev = config.nodeEnv !== "production";
    const allowedOrigins = new Set([
        ...config.corsAllowedOrigins,
        ...(isDev ? localhostOrigins : []),
    ]);

    const app = Fastify({
        logger: buildLoggerOptions(),
    });

    await app.register(cors, {
        origin(origin, cb) {
            if (!origin) {
                cb(null, true);
                return;
            }

            const isAllowed = allowedOrigins.has(origin);
            let parsedOrigin = null;

            try {
                parsedOrigin = new URL(origin);
            } catch {
                app.log.warn({
                    event: "cors_origin_denied",
                    reason: "invalid_origin_format",
                    hasOrigin: true,
                });
                cb(new Error("Not allowed by CORS"), false);
                return;
            }

            app.log.info({
                event: isAllowed ? "cors_origin_allowed" : "cors_origin_denied",
                hasOrigin: true,
                protocol: parsedOrigin.protocol,
                hostname: parsedOrigin.hostname,
                port: parsedOrigin.port || null,
                env: config.nodeEnv,
            });

            if (!isAllowed) {
                cb(new Error("Not allowed by CORS"), false);
                return;
            }

            cb(null, true);
        },
        methods: ["GET", "POST", "PUT"],
        credentials: true,
    });
    app.addHook("onRequest", async (_req, reply) => {
        reply.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    });

    app.register(maxWebhookRoutes);
    app.register(onecExchangeRoutes);
    app.register(versionRoutes);
    app.get("/healthz", async () => ({ status: "ok" }));

    return app;
}
