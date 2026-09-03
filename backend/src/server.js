import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closeRedisClient, getRedisClient } from "./store/redisClient.js";
import { finishOneCSessions, startOneCSessions } from "./services/onecRouter.js";

const app = await buildApp();

await getRedisClient();
await startOneCSessions();

app.addHook("onClose", async () => {
    await finishOneCSessions();
    await closeRedisClient();
});

const shutdown = async (signal) => {
    app.log.info({ signal }, "graceful shutdown started");
    try {
        await app.close();
    } finally {
        process.exit(0);
    }
};

process.on("SIGINT", () => {
    void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
});

app.listen({ port: config.port, host: "0.0.0.0" })
    .then(() => {
        console.log("server is running");
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
