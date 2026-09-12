import { config } from "../config.js";

// Intentionally below the provider maximum: bounded JSON/base64 for 1C.
export const attachmentMaxBytes = 5 * 1024 * 1024;
export const attachmentBodyLimit = 4 * Math.ceil(attachmentMaxBytes / 3) + 4096;
export const attachmentExtensions = ["pdf", "doc", "docx", "xls", "xlsx", "txt", "png", "jpg", "jpeg"];
const mimeTypes = {
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};
let uploadsInProgress = 0;

export function normalizeAttachmentUpload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || Object.keys(payload).some((key) => !["filename", "data_base64"].includes(key))) {
        throw new Error("attachment_upload_invalid");
    }
    const filename = payload.filename;
    // No path, control character, alternate data stream, or disguised extension.
    if (typeof filename !== "string" || !filename || filename.length > 180
        || /[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(filename)
        || filename !== filename.trim() || filename.startsWith(".") || filename.endsWith(".")) {
        throw new Error("attachment_filename_invalid");
    }
    const extension = filename.split(".").at(-1).toLowerCase();
    if (!filename.includes(".") || !attachmentExtensions.includes(extension)) {
        throw new Error("attachment_extension_not_allowed");
    }
    const base64 = payload.data_base64;
    if (typeof base64 !== "string" || base64.length > 4 * Math.ceil(attachmentMaxBytes / 3)) {
        throw new Error("attachment_size_invalid");
    }
    // Buffer.from alone silently accepts malformed/truncated base64.
    if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error("attachment_base64_invalid");
    }
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length || bytes.length > attachmentMaxBytes) throw new Error("attachment_size_invalid");
    if (bytes.toString("base64") !== base64) throw new Error("attachment_base64_invalid");
    return { filename, bytes, mimeType: mimeTypes[extension] };
}

export function validateMaxUploadUrl(rawUrl) {
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error("max_upload_url_rejected"); }
    // Only file uploads are supported. Provider-issued URL, never supplied by 1C.
    if (url.protocol !== "https:" || url.hostname !== "fu.oneme.ru"
        || url.port || url.username || url.password || url.hash) {
        throw new Error("max_upload_url_rejected");
    }
    return url.href;
}

async function readUploadJson(response) {
    // Bound provider replies too; never return raw provider errors or signed URLs.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("max_upload_response_invalid");
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 65536) throw new Error("max_upload_response_invalid");
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        await reader.cancel().catch(() => {});
        throw new Error("max_upload_response_invalid");
    } finally {
        reader.releaseLock();
    }
}

export async function uploadMaxAttachment(normalized) {
    if (!config.maxBotToken) throw new Error("max_bot_token_not_configured");
    // A small, per-process concurrency bound. No file persistence on disk/Redis.
    if (uploadsInProgress >= 2) throw new Error("attachment_upload_busy");
    uploadsInProgress += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.maxRequestTimeoutMs);
    try {
        const endpoint = `${String(config.maxApiBaseUrl).replace(/\/+$/, "")}/uploads?type=file`;
        const uploadEndpoint = await fetch(endpoint, {
            method: "POST", headers: { Authorization: config.maxBotToken },
            redirect: "error", signal: controller.signal,
        });
        if (!uploadEndpoint.ok) {
            await uploadEndpoint.body?.cancel();
            throw new Error("max_upload_endpoint_failed");
        }
        const { url } = await readUploadJson(uploadEndpoint);
        const uploadUrl = validateMaxUploadUrl(url);
        const form = new FormData();
        form.append("data", new Blob([normalized.bytes], { type: normalized.mimeType }), normalized.filename);
        const uploaded = await fetch(uploadUrl, {
            method: "POST", body: form, redirect: "error", signal: controller.signal,
            // Never forward the bot token or service key to the upload host.
        });
        if (!uploaded.ok) {
            await uploaded.body?.cancel();
            throw new Error("max_upload_failed");
        }
        const { token } = await readUploadJson(uploaded);
        if (typeof token !== "string" || !token.trim() || token.length > 16384) {
            throw new Error("max_upload_response_invalid");
        }
        return {
            attachment: { type: "file", payload: { token } },
            filename: normalized.filename, size: normalized.bytes.length,
        };
    } finally {
        clearTimeout(timeout);
        uploadsInProgress -= 1;
    }
}
