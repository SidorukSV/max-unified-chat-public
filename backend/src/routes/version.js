import { config } from "../config.js";

export async function versionRoutes(app) {
    app.get("/api/v1/version", async () => ({
        status: "ok",
        appVersion: config.appVersion,
        backendVersion: config.backendVersion,
        gitCommit: config.gitCommit,
        buildTime: config.buildTime,
        nodeEnv: config.nodeEnv,
    }));
}
