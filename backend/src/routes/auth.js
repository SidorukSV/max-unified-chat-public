import crypto from "crypto";
import { createSession, updateSession } from "../store/authSessions.js";
import { config } from "../config.js";
import { getPatientsByPhone } from "../services/onecRouter.js";
import { normalizePhoneMiddleware, sessionMiddleware } from "../middleware/session.js";
import { signAccessToken, signRefreshToken, verifyToken, ACCESS_TOKEN_EXPIRES_SECONDS, REFRESH_TOKEN_EXPIRES_SECONDS } from "../auth/jwt.js";
import {
    saveRefreshToken,
    getRefreshToken,
    deleteRefreshToken,
    revokeUserRefreshTokens,
    revokeUserDeviceRefreshTokens,
} from "../store/refreshTokens.js";
import { verifyMaxInitData } from "../auth/maxInitData.js";
import { sendApiError } from "../utils/apiErrors.js";
import { verifyDevTotpCode } from "../auth/devTotp.js";
import {
    consumeAuthAttemptBudget,
    recordAuthAttempt,
    sendAuthRateLimit,
    sendUnifiedAuthFailure,
} from "../middleware/authAttemptGuard.js";
import { authMiddleware } from "../middleware/auth.js";


export function getAllowedAuthChannels(nodeEnv) {
    if (nodeEnv === "production") {
        return new Set(["max", "1c"]);
    }

    return new Set(["max", "web", "1c"]);
}

export function validateAuthChannelProof({
    nodeEnv,
    channel,
    proof,
    initData,
    maxBotToken,
    maxInitDataMaxAgeSeconds,
    devTotpSecret,
    devTotpPeriodSeconds,
    devTotpWindow,
}) {
    const allowedChannels = getAllowedAuthChannels(nodeEnv);

    if (!allowedChannels.has(channel)) {
        return {
            ok: false,
            statusCode: 403,
            errorCode: "auth_channel_not_allowed",
        };
    }

    if (channel === "max") {
        try {
            const verifiedMaxInitData = verifyMaxInitData(initData, {
                botToken: maxBotToken,
                maxAgeSeconds: maxInitDataMaxAgeSeconds,
            });

            return {
                ok: true,
                verifiedMaxInitData,
            };
        } catch {
            return {
                ok: false,
                statusCode: 401,
                errorCode: "init_data_invalid",
            };
        }
    }

    if (channel === "web") {
        if (!devTotpSecret) {
            return {
                ok: false,
                statusCode: 503,
                errorCode: "dev_totp_not_configured",
            };
        }

        try {
            const isValidDevTotp = verifyDevTotpCode({
                code: proof?.totp_code || proof?.totpCode || null,
                secret: devTotpSecret,
                periodSeconds: devTotpPeriodSeconds,
                window: devTotpWindow,
            });

            if (!isValidDevTotp) {
                return {
                    ok: false,
                    statusCode: 401,
                    errorCode: "dev_totp_invalid",
                };
            }
        } catch {
            return {
                ok: false,
                statusCode: 401,
                errorCode: "dev_totp_invalid",
            };
        }

        return { ok: true };
    }

    if (channel === "1c") {
        if (!devTotpSecret) {
            return {
                ok: false,
                statusCode: 503,
                errorCode: "onec_totp_not_configured",
            };
        }

        try {
            const isValidTotp = verifyDevTotpCode({
                code: proof?.totp_code || proof?.totpCode || null,
                secret: devTotpSecret,
                periodSeconds: devTotpPeriodSeconds,
                window: devTotpWindow,
            });

            if (!isValidTotp) {
                return {
                    ok: false,
                    statusCode: 401,
                    errorCode: "onec_totp_invalid",
                };
            }
        } catch {
            return {
                ok: false,
                statusCode: 401,
                errorCode: "onec_totp_invalid",
            };
        }

        return { ok: true };
    }

    return {
        ok: false,
        statusCode: 403,
        errorCode: "auth_channel_not_allowed",
    };
}

function hashUserAgent(userAgent) {
    const normalizedUserAgent = (userAgent || "unknown").trim().toLowerCase();
    return crypto.createHash("sha256").update(normalizedUserAgent).digest("hex");
}

function getDeviceId(req) {
    const fromBody = req.body?.device_id || req.body?.deviceId || null;
    const fromHeader = req.headers["x-device-id"] || null;

    const candidate = typeof fromBody === "string" && fromBody.trim() ? fromBody : fromHeader;

    if (typeof candidate !== "string") {
        return null;
    }

    const value = candidate.trim();
    return value || null;
}

function buildRefreshTokenContext(req, channelFallback = "unknown") {
    const channel = req.body?.channel || channelFallback || "unknown";

    return {
        user_agent_hash: hashUserAgent(req.headers["user-agent"]),
        device_id: getDeviceId(req),
        channel,
        last_used_at: new Date().toISOString(),
    };
}

function isRefreshContextMatch(stored, current) {
    const storedChannel = stored?.channel || "unknown";
    const currentChannel = current?.channel || "unknown";

    return stored?.user_agent_hash === current?.user_agent_hash
        && (stored?.device_id || null) === (current?.device_id || null)
        && storedChannel === currentChannel;
}

function isSecureRequest(req) {
    const forwardedProto = req.headers?.["x-forwarded-proto"];

    if (typeof forwardedProto === "string" && forwardedProto.toLowerCase().includes("https")) {
        return true;
    }

    return req.protocol === "https";
}

function getRefreshCookieOptions(req) {
    const rawSameSite = String(config.refreshCookieSameSite || "none").trim().toLowerCase();
    let sameSite = rawSameSite === "strict"
        ? "Strict"
        : rawSameSite === "lax"
            ? "Lax"
            : "None";
    const secure = Boolean(config.refreshCookieSecure) || isSecureRequest(req);

    if (!secure && sameSite === "None") {
        sameSite = "Lax";
    }

    return {
        httpOnly: true,
        secure,
        sameSite,
        path: "/",
    };
}

function getCookieHeader(req) {
    const cookieCandidates = [
        req.headers?.cookie,
        req.headers?.Cookie,
        req.raw?.headers?.cookie,
        req.raw?.headers?.Cookie,
    ];

    const directMatch = cookieCandidates.find((candidate) => typeof candidate === "string" && candidate.trim());

    if (directMatch) {
        return directMatch;
    }

    const rawHeaders = req.raw?.rawHeaders;
    if (!Array.isArray(rawHeaders)) {
        return null;
    }

    for (let i = 0; i < rawHeaders.length; i += 2) {
        const name = rawHeaders[i];
        const value = rawHeaders[i + 1];

        if (typeof name === "string" && name.toLowerCase() === "cookie" && typeof value === "string" && value.trim()) {
            return value;
        }
    }

    return null;
}

function parseCookies(req) {
    const cookieHeader = getCookieHeader(req);
    if (!cookieHeader || typeof cookieHeader !== "string") {
        return {};
    }

    return cookieHeader.split(";").reduce((acc, segment) => {
        const [rawName, ...rest] = segment.trim().split("=");
        if (!rawName) return acc;
        acc[rawName] = decodeURIComponent(rest.join("=") || "");
        return acc;
    }, {});
}

function getRefreshTokenFromRequest(req) {
    const normalizeRefreshToken = (token) => {
        if (typeof token !== "string") {
            return null;
        }

        const normalized = token.trim();
        if (!normalized) {
            return null;
        }

        if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(normalized)) {
            return null;
        }

        return normalized;
    };

    const fromHeader = req.headers?.["x-refresh-token"];
    const normalizedHeader = normalizeRefreshToken(fromHeader);
    if (normalizedHeader) {
        return { token: normalizedHeader, source: "header" };
    }

    const fromBody = req.body?.refresh_token || req.body?.refreshToken;
    const normalizedBody = normalizeRefreshToken(fromBody);
    if (normalizedBody) {
        return { token: normalizedBody, source: "body" };
    }

    const fromCookie = parseCookies(req)?.[config.refreshCookieName];
    const normalizedCookie = normalizeRefreshToken(fromCookie);
    if (normalizedCookie) {
        return { token: normalizedCookie, source: "cookie" };
    }

    return { token: null, source: null };
}

function getRequestOrigin(req) {
    const forwardedProto = req.headers?.["x-forwarded-proto"];
    const forwardedHost = req.headers?.["x-forwarded-host"];
    const protocol = (typeof forwardedProto === "string" ? forwardedProto.split(",")[0] : req.protocol || "http").trim();
    const host = (typeof forwardedHost === "string" ? forwardedHost.split(",")[0] : req.headers?.host || "").trim();

    return protocol && host ? `${protocol}://${host}` : null;
}

function getBrowserRequestOrigin(req) {
    const origin = req.headers?.origin;
    if (typeof origin === "string" && origin.trim()) {
        return origin.trim();
    }

    const referer = req.headers?.referer;
    if (typeof referer !== "string" || !referer.trim()) {
        return null;
    }

    try {
        return new URL(referer).origin;
    } catch {
        return null;
    }
}

export function isCookieAuthRequestOriginAllowed(req) {
    const browserOrigin = getBrowserRequestOrigin(req);
    if (!browserOrigin) {
        return false;
    }

    const allowedOrigins = new Set(config.corsAllowedOrigins);
    const requestOrigin = getRequestOrigin(req);
    if (requestOrigin) {
        allowedOrigins.add(requestOrigin);
    }

    if (config.nodeEnv !== "production") {
        allowedOrigins.add("http://localhost:3000");
        allowedOrigins.add("http://127.0.0.1:3000");
        allowedOrigins.add("http://localhost:5173");
        allowedOrigins.add("http://127.0.0.1:5173");
    }

    return allowedOrigins.has(browserOrigin);
}

function validateRefreshTokenRequestOrigin(req, reply, tokenSource) {
    if (tokenSource !== "cookie" || isCookieAuthRequestOriginAllowed(req)) {
        return true;
    }

    sendApiError(reply, 403, "csrf_origin_invalid");
    return false;
}

function shouldExposeRefreshToken(channel) {
    return channel === "max" || channel === "1c";
}

function buildCookieHeaderValue(req, name, value, maxAgeSeconds = null) {
    const options = getRefreshCookieOptions(req);
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, "HttpOnly", `SameSite=${options.sameSite}`];
    if (options.secure) {
        parts.push("Secure");
    }
    if (typeof maxAgeSeconds === "number") {
        parts.push(`Max-Age=${maxAgeSeconds}`);
        parts.push(`Expires=${new Date(Date.now() + (maxAgeSeconds * 1000)).toUTCString()}`);
    }
    return parts.join("; ");
}

function setRefreshCookie(req, reply, refreshToken, maxAgeSeconds) {
    reply.header("Set-Cookie", buildCookieHeaderValue(req, config.refreshCookieName, refreshToken, maxAgeSeconds));
}

function clearRefreshCookie(req, reply) {
    reply.header("Set-Cookie", buildCookieHeaderValue(req, config.refreshCookieName, "", 0));
}

export async function authRoutes(app) {
    const phoneAttemptPolicy = {
        windowMs: 60_000,
        limit: 6,
        lockMs: 30_000,
        lockAfterFailures: 3,
    };
    const oneCAttemptPolicy = {
        windowMs: 60_000,
        limit: 6,
        lockMs: 30_000,
        lockAfterFailures: 3,
    };
    const selectPatientAttemptPolicy = {
        windowMs: 60_000,
        limit: 8,
        lockMs: 30_000,
        lockAfterFailures: 3,
    };

    app.post("/api/v1/auth/start", async () => {
        const auth_session_id = await createSession();

        return {
            auth_session_id,
        };
    });

    app.post("/api/v1/auth/onec", async (req, reply) => {
        const { proof } = req.body || {};
        const channel = "1c";

        const oneCAttemptDimensions = {
            ip: req.ip,
        };

        const oneCRateLimit = consumeAuthAttemptBudget({
            scope: "auth_onec",
            dimensions: oneCAttemptDimensions,
            policy: oneCAttemptPolicy,
        });

        if (oneCRateLimit.limited) {
            return sendAuthRateLimit(reply, oneCRateLimit.retryAfterSeconds);
        }

        const proofValidation = validateAuthChannelProof({
            nodeEnv: config.nodeEnv,
            channel,
            proof,
            initData: null,
            maxBotToken: config.maxBotToken,
            maxInitDataMaxAgeSeconds: config.maxInitDataMaxAgeSeconds,
            devTotpSecret: config.oneCConfig?.onecTotpSecret || "",
            devTotpPeriodSeconds: config.devTotpPeriodSeconds,
            devTotpWindow: config.devTotpWindow,
        });

        if (!proofValidation.ok) {
            recordAuthAttempt({
                scope: "auth_onec",
                dimensions: oneCAttemptDimensions,
                success: false,
                policy: oneCAttemptPolicy,
            });
            return sendUnifiedAuthFailure(reply);
        }

        recordAuthAttempt({
            scope: "auth_onec",
            dimensions: oneCAttemptDimensions,
            success: true,
            policy: oneCAttemptPolicy,
        });

        const tokenPayload = {
            channel,
            integration: "1c",
        };

        const access_token = signAccessToken(tokenPayload);
        const refresh_token = signRefreshToken(tokenPayload);
        const decodedRefreshToken = verifyToken(refresh_token);
        const refreshContext = buildRefreshTokenContext(req, channel);

        await saveRefreshToken(decodedRefreshToken.jti, {
            ...tokenPayload,
            ...refreshContext,
            expiresAt: decodedRefreshToken.exp * 1000,
        });

        setRefreshCookie(req, reply, refresh_token, REFRESH_TOKEN_EXPIRES_SECONDS);

        return {
            access_token,
            refresh_token,
            expires_in: ACCESS_TOKEN_EXPIRES_SECONDS,
            channel,
        };
    });

    app.post("/api/v1/auth/phone",
        { preHandler: [sessionMiddleware, normalizePhoneMiddleware] },
        async (req, reply) => {
            const { channel, proof, init_data } = req.body || {};
            const session = req.session;
            const authChannel = channel || "unknown";
            const maxInitData = init_data || proof?.init_data || proof?.initData || null;
            const phoneAttemptDimensions = {
                ip: req.ip,
                phone: req.phone,
            };

            const phoneRateLimit = consumeAuthAttemptBudget({
                scope: "auth_phone",
                dimensions: phoneAttemptDimensions,
                policy: phoneAttemptPolicy,
            });

            if (phoneRateLimit.limited) {
                return sendAuthRateLimit(reply, phoneRateLimit.retryAfterSeconds);
            }

            const proofValidation = validateAuthChannelProof({
                nodeEnv: config.nodeEnv,
                channel: authChannel,
                proof,
                initData: maxInitData,
                maxBotToken: config.maxBotToken,
                maxInitDataMaxAgeSeconds: config.maxInitDataMaxAgeSeconds,
                devTotpSecret: config.devTotpSecret,
                devTotpPeriodSeconds: config.devTotpPeriodSeconds,
                devTotpWindow: config.devTotpWindow,
            });

            if (!proofValidation.ok) {
                req.log.warn({
                    endpoint: "/api/v1/auth/phone",
                    operation: "validateAuthChannelProof",
                    channel: authChannel,
                    errorCode: proofValidation.errorCode,
                }, "Auth channel proof validation failed");
                recordAuthAttempt({
                    scope: "auth_phone",
                    dimensions: phoneAttemptDimensions,
                    success: false,
                    policy: phoneAttemptPolicy,
                });
                return sendUnifiedAuthFailure(reply);
            }

            const verifiedMaxInitData = proofValidation.verifiedMaxInitData || null;
            req.session = await updateSession(session.id, {
                phone: req.phone,
                channel: authChannel,
                proof: proof || null,
                max_user: verifiedMaxInitData?.user || null,
            });

            const patients = await getPatientsByPhone({
                phone: req.phone,
            });

            const patients_sorted = [...patients].sort((a, b) => { return a.fullName.toUpperCase().localeCompare(b.fullName.toUpperCase()) }); 

            req.session = await updateSession(session.id, {
                patients: patients_sorted,
            });

            recordAuthAttempt({
                scope: "auth_phone",
                dimensions: phoneAttemptDimensions,
                success: true,
                policy: phoneAttemptPolicy,
            });

            return {
                need_select_patient: true,
                patients: patients_sorted,
            };
        });

    app.post("/api/v1/auth/select-patient",
        { preHandler: [sessionMiddleware] },
        async (req, reply) => {
            const { patient_id } = req.body || {};
            const session = req.session;
            const selectAttemptDimensions = {
                ip: req.ip,
                session: session.id,
            };

            const selectRateLimit = consumeAuthAttemptBudget({
                scope: "auth_select_patient",
                dimensions: selectAttemptDimensions,
                policy: selectPatientAttemptPolicy,
            });

            if (selectRateLimit.limited) {
                return sendAuthRateLimit(reply, selectRateLimit.retryAfterSeconds);
            }

            if (!patient_id) {
                recordAuthAttempt({
                    scope: "auth_select_patient",
                    dimensions: selectAttemptDimensions,
                    success: false,
                    policy: selectPatientAttemptPolicy,
                });
                return sendUnifiedAuthFailure(reply);
            }

            const patients = session.patients;

            if (!patients.length) {
                recordAuthAttempt({
                    scope: "auth_select_patient",
                    dimensions: selectAttemptDimensions,
                    success: false,
                    policy: selectPatientAttemptPolicy,
                });
                return sendUnifiedAuthFailure(reply);
            }

            const patient = patients.find((patient) => patient.id === patient_id);

            if (!patient) {
                recordAuthAttempt({
                    scope: "auth_select_patient",
                    dimensions: selectAttemptDimensions,
                    success: false,
                    policy: selectPatientAttemptPolicy,
                });
                return sendUnifiedAuthFailure(reply);
            }

            const tokenPayload = {
                patient_id: patient.id,
                phone: session.phone,
                channel: session.channel || "unknown",
            };

            const access_token = signAccessToken(tokenPayload);
            const refresh_token = signRefreshToken(tokenPayload);

            const decodeRefresh = verifyToken(refresh_token);

            const refreshContext = buildRefreshTokenContext(req, tokenPayload.channel);

            await saveRefreshToken(decodeRefresh.jti, {
                ...tokenPayload,
                ...refreshContext,
                expiresAt: decodeRefresh.exp * 1000,
            });

            req.log.info({
                event: "auth_refresh_issued",
                endpoint: "/api/v1/auth/select-patient",
                patientId: patient.id,
                channel: refreshContext.channel,
                hasDeviceId: Boolean(refreshContext.device_id),
            }, "Refresh token issued");

            req.session = await updateSession(session.id, {
                selected_patient_id: patient.id,
            });
            req.log.info({
                endpoint: "/api/v1/auth/select-patient",
                operation: "selectPatient",
            }, "Patient selected for auth session");

            recordAuthAttempt({
                scope: "auth_select_patient",
                dimensions: selectAttemptDimensions,
                success: true,
                policy: selectPatientAttemptPolicy,
            });

            setRefreshCookie(req, reply, refresh_token, REFRESH_TOKEN_EXPIRES_SECONDS);

            return {
                access_token,
                expires_in: ACCESS_TOKEN_EXPIRES_SECONDS,
                ...(shouldExposeRefreshToken(tokenPayload.channel) ? { refresh_token } : {}),
                patient,
            };

        });

    app.post("/api/v1/auth/switch-patient",
        { preHandler: [authMiddleware] },
        async (req, reply) => {
            const { patient_id } = JSON.parse(req.body) || {};
            const { phone, channel } = req.user;

            if (!patient_id) {
                return sendApiError(reply, 400, "patient_id_required");
            }

            let patients = [];
            try {
                patients = await getPatientsByPhone({
                    phone,
                });
            } catch (error) {
                req.log.error({
                    endpoint: "/api/v1/auth/switch-patient",
                    operation: "getPatientsByPhone",
                    err: error,
                }, "Failed to load patients by phone for switching");
                return sendApiError(reply, 502, "patients_unavailable");
            }

            const patient = patients.find((candidate) => candidate.id === patient_id);

            if (!patient) {
                return sendApiError(reply, 404, "patient_not_found");
            }

            const tokenPayload = {
                patient_id: patient.id,
                phone,
                channel: channel || "unknown",
            };

            const access_token = signAccessToken(tokenPayload);
            const refresh_token = signRefreshToken(tokenPayload);
            const decodedRefreshToken = verifyToken(refresh_token);
            const refreshContext = buildRefreshTokenContext(req, tokenPayload.channel);
            await saveRefreshToken(decodedRefreshToken.jti, {
                ...tokenPayload,
                ...refreshContext,
                expiresAt: decodedRefreshToken.exp * 1000,
            });
            setRefreshCookie(req, reply, refresh_token, REFRESH_TOKEN_EXPIRES_SECONDS);

            return {
                access_token,
                expires_in: ACCESS_TOKEN_EXPIRES_SECONDS,
                ...(shouldExposeRefreshToken(tokenPayload.channel) ? { refresh_token } : {}),
                patient,
            };
        });

    app.post("/api/v1/auth/refresh", async (req, reply) => {
        const { token: refresh_token, source: refreshTokenSource } = getRefreshTokenFromRequest(req);

        if (!refresh_token) {
            return sendApiError(reply, 400, "refresh_token_required");
        }
        if (!validateRefreshTokenRequestOrigin(req, reply, refreshTokenSource)) {
            return;
        }

        let decoded;
        try {
            decoded = verifyToken(refresh_token);
        } catch {
            return sendApiError(reply, 401, "invalid_refresh_token");
        }

        if (decoded.token_type !== "refresh") {
           return sendApiError(reply, 401, "invalid_token_type");
        }

        const stored = await getRefreshToken(decoded.jti);

        if (!stored) {
            return sendApiError(reply, 401, "refresh_token_revoked");
        }

        const currentContext = buildRefreshTokenContext(req, stored.channel);

        if (!isRefreshContextMatch(stored, currentContext)) {
            await deleteRefreshToken(decoded.jti);

            req.log.warn({
                event: "auth_refresh_rejected_context_mismatch",
                endpoint: "/api/v1/auth/refresh",
                patientId: stored.patient_id,
                tokenJti: decoded.jti,
                storedContext: {
                    userAgentHash: stored.user_agent_hash,
                    deviceId: stored.device_id || null,
                    channel: stored.channel || "unknown",
                },
                currentContext: {
                    userAgentHash: currentContext.user_agent_hash,
                    deviceId: currentContext.device_id || null,
                    channel: currentContext.channel,
                },
            }, "Refresh token rejected due to context mismatch");

            return sendApiError(reply, 401, "refresh_context_mismatch");
        }

        await deleteRefreshToken(decoded.jti);

        const tokenPayload = {
            patient_id: stored.patient_id,
            phone: stored.phone,
            channel: stored.channel,
        };

        const access_token = signAccessToken(tokenPayload);
        const new_refresh_token = signRefreshToken(tokenPayload);

        const newDecodedRefresh = verifyToken(new_refresh_token);

        await saveRefreshToken(newDecodedRefresh.jti, {
            ...tokenPayload,
            ...currentContext,
            expiresAt: newDecodedRefresh.exp * 1000,
        });

        req.log.info({
            event: "auth_refresh_success",
            endpoint: "/api/v1/auth/refresh",
            patientId: stored.patient_id,
            oldTokenJti: decoded.jti,
            newTokenJti: newDecodedRefresh.jti,
            channel: currentContext.channel,
            hasDeviceId: Boolean(currentContext.device_id),
        }, "Refresh token rotated");

        setRefreshCookie(req, reply, new_refresh_token, REFRESH_TOKEN_EXPIRES_SECONDS);

        return {
            access_token,
            expires_in: ACCESS_TOKEN_EXPIRES_SECONDS,
            ...(shouldExposeRefreshToken(tokenPayload.channel) ? { refresh_token: new_refresh_token } : {}),
        };
    });

    app.post("/api/v1/auth/logout", async (req, reply) => {
        const { revoke_scope } = req.body || {};
        const { token: refresh_token, source: refreshTokenSource } = getRefreshTokenFromRequest(req);

        if (!refresh_token) {
            clearRefreshCookie(req, reply);
            return sendApiError(reply, 400, "refresh_token_required");
        }
        if (!validateRefreshTokenRequestOrigin(req, reply, refreshTokenSource)) {
            return;
        }

        let revokedCount = 0;

        try {
            const decoded = verifyToken(refresh_token);

            if (decoded.token_type === "refresh") {
                const stored = await getRefreshToken(decoded.jti);

                if (stored?.patient_id) {
                    const scope = revoke_scope || (stored.device_id ? "device" : "token");

                    if (scope === "user") {
                        revokedCount = await revokeUserRefreshTokens(stored.patient_id);
                    } else if (scope === "device" && stored.device_id) {
                        revokedCount = await revokeUserDeviceRefreshTokens(stored.patient_id, stored.device_id);
                    } else {
                        await deleteRefreshToken(decoded.jti);
                        revokedCount = 1;
                    }

                    req.log.info({
                        event: "auth_logout",
                        endpoint: "/api/v1/auth/logout",
                        patientId: stored.patient_id,
                        revokeScope: scope,
                        revokedCount,
                        channel: stored.channel || "unknown",
                        hasDeviceId: Boolean(stored.device_id),
                    }, "Logout completed with refresh revocation");
                } else {
                    await deleteRefreshToken(decoded.jti);
                    revokedCount = 1;
                }
            }
        } catch {
            // no-action: always logout
        }

        clearRefreshCookie(req, reply);
        return { ok: true, revoked_count: revokedCount };
    })
}
