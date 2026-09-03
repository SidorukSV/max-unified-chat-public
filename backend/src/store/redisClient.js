import net from "net";
import { URL } from "url";
import { config } from "../config.js";

class RedisClient {
    constructor(redisUrl, connectTimeoutMs = 5000) {
        const parsed = new URL(redisUrl);

        this.host = parsed.hostname;
        this.port = Number(parsed.port || 6379);
        this.password = parsed.password || null;
        this.db = parsed.pathname && parsed.pathname !== "/" ? Number(parsed.pathname.slice(1)) : null;
        this.connectTimeoutMs = connectTimeoutMs;

        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.pending = [];
        this.connected = false;
    }

    get isOpen() {
        return this.connected;
    }

    async connect() {
        if (this.connected) return;

        await new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            let timeout;

            const onError = (err) => {
                clearTimeout(timeout);
                socket.destroy();
                reject(err);
            };

            socket.once("error", onError);

            timeout = setTimeout(() => {
                socket.destroy(new Error("Redis connection timeout"));
            }, this.connectTimeoutMs);

            socket.once("connect", async () => {
                clearTimeout(timeout);
                socket.off("error", onError);

                this.socket = socket;
                this.connected = true;

                socket.on("data", (chunk) => this.handleData(chunk));
                socket.on("close", () => {
                    this.connected = false;
                    const err = new Error("Redis connection closed");
                    while (this.pending.length) {
                        this.pending.shift().reject(err);
                    }
                });
                socket.on("error", (err) => {
                    console.error("Redis socket error", err);
                });

                try {
                    if (this.password) {
                        await this.send(["AUTH", this.password]);
                    }

                    if (this.db !== null && Number.isFinite(this.db)) {
                        await this.send(["SELECT", String(this.db)]);
                    }

                    resolve();
                } catch (err) {
                    reject(err);
                }
            });
        });
    }

    async set(key, value, options = {}) {
        const args = ["SET", key, value];

        if (options.EX) {
            args.push("EX", String(options.EX));
        }

        await this.send(args);
    }

    async get(key) {
        return this.send(["GET", key]);
    }

    async del(key) {
        return this.send(["DEL", key]);
    }

    async quit() {
        if (!this.connected) return;

        try {
            await this.send(["QUIT"]);
        } finally {
            this.socket?.end();
            this.connected = false;
        }
    }

    send(args) {
        if (!this.socket || !this.connected) {
            return Promise.reject(new Error("Redis is not connected"));
        }

        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            this.socket.write(encodeCommand(args));
        });
    }

    handleData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);

        while (this.pending.length) {
            const parsed = parseResp(this.buffer);
            if (!parsed) return;

            this.buffer = parsed.rest;
            const pending = this.pending.shift();

            if (parsed.value instanceof Error) {
                pending.reject(parsed.value);
            } else {
                pending.resolve(parsed.value);
            }
        }
    }
}

function encodeCommand(args) {
    const parts = [`*${args.length}\r\n`];

    for (const arg of args) {
        const str = String(arg);
        parts.push(`$${Buffer.byteLength(str)}\r\n${str}\r\n`);
    }

    return parts.join("");
}

function parseResp(buffer) {
    if (!buffer.length) return null;

    const type = String.fromCharCode(buffer[0]);

    if (type === "+" || type === "-" || type === ":") {
        const end = buffer.indexOf("\r\n");
        if (end === -1) return null;

        const raw = buffer.subarray(1, end).toString("utf8");
        const rest = buffer.subarray(end + 2);

        if (type === "-") {
            return { value: new Error(raw), rest };
        }

        if (type === ":") {
            return { value: Number(raw), rest };
        }

        return { value: raw, rest };
    }

    if (type === "$") {
        const end = buffer.indexOf("\r\n");
        if (end === -1) return null;

        const len = Number(buffer.subarray(1, end).toString("utf8"));
        if (len === -1) {
            return { value: null, rest: buffer.subarray(end + 2) };
        }

        const start = end + 2;
        const payloadEnd = start + len;

        if (buffer.length < payloadEnd + 2) {
            return null;
        }

        const value = buffer.subarray(start, payloadEnd).toString("utf8");
        const rest = buffer.subarray(payloadEnd + 2);

        return { value, rest };
    }

    throw new Error(`Unsupported Redis response type: ${type}`);
}

let redisClient;

export async function getRedisClient() {
    if (!redisClient) {
        redisClient = new RedisClient(config.redisUrl, config.redisConnectTimeoutMs);
    }

    if (!redisClient.isOpen) {
        await redisClient.connect();
    }

    return redisClient;
}

export async function closeRedisClient() {
    if (redisClient?.isOpen) {
        await redisClient.quit();
    }
}
