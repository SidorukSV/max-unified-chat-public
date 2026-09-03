import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { config } from "../config.js";
import ms from "ms";

const ACCESS_EXPIRES_IN = "30m";
const REFRESH_EXPIRES_IN = "30d";

export const ACCESS_TOKEN_EXPIRES_SECONDS = ms(ACCESS_EXPIRES_IN) / 1000;
export const REFRESH_TOKEN_EXPIRES_SECONDS = ms(REFRESH_EXPIRES_IN) / 1000;

export function signAccessToken(payload){
    return jwt.sign(payload, config.jwtSecret, {
        expiresIn: ACCESS_EXPIRES_IN,
    });
}

export function signRefreshToken(payload) {
    return jwt.sign(
        {
            ...payload,
            token_type: "refresh",
            jti: randomUUID(),
        },
        config.jwtSecret,
        {
            expiresIn: REFRESH_EXPIRES_IN,
        }
    );
}

export function verifyToken(token){
    return jwt.verify(token, config.jwtSecret);
}