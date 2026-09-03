import { verifyToken } from "../auth/jwt.js";
import { sendApiError } from "../utils/apiErrors.js";

export async function authMiddleware(req, reply) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader) {
            return sendApiError(reply, 401, "no_token");
        }

        const token = authHeader.replace("Bearer ", "");

        const decoded = verifyToken(token);
        if (decoded.token_type === "refresh") {
            return sendApiError(reply, 401, "invalid_token_type");
        }

        req.user = decoded;
    } catch (err) {
        return sendApiError(reply, 401, "invalid_token");
    }
}
