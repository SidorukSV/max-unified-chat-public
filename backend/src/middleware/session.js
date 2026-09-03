import { getSession } from "../store/authSessions.js";
import { sendApiError } from "../utils/apiErrors.js";

export async function sessionMiddleware(req, reply) {
    const { auth_session_id } = req.body || {};

    if (!auth_session_id) {
        return sendApiError(reply, 400, "auth_session_id_required");
    }

    const session = await getSession(auth_session_id);

    if (!session) {
        return sendApiError(reply, 400, "invalid_session");
    }

    if (session.expiresAt < Date.now()) {
        return sendApiError(reply, 400, "session_expired");
    }

    req.session = session;
}

export async function normalizePhoneMiddleware(req, reply) {
    const normalizePhone = String(req.body.phone || "").replace(/[^\d+]/g, "");
    if (!normalizePhone) {
        return sendApiError(reply, 400, "invalid_phone");
    }

    req.phone = normalizePhone;
}
