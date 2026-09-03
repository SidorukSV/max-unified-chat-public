import crypto from "node:crypto";

function normalizeBase32(value) {
    return String(value || "")
        .toUpperCase()
        .replace(/=+$/g, "")
        .replace(/[^A-Z2-7]/g, "");
}

function decodeBase32(secret) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const normalized = normalizeBase32(secret);

    if (!normalized) {
        throw new Error("dev_totp_secret_required");
    }

    let bits = "";
    for (const char of normalized) {
        const index = alphabet.indexOf(char);

        if (index === -1) {
            throw new Error("dev_totp_secret_invalid");
        }

        bits += index.toString(2).padStart(5, "0");
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
    }

    return Buffer.from(bytes);
}

function generateTotp(secretBuffer, counter, digits = 6) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));

    const hmac = crypto.createHmac("sha1", secretBuffer).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binaryCode = ((hmac[offset] & 0x7f) << 24)
        | ((hmac[offset + 1] & 0xff) << 16)
        | ((hmac[offset + 2] & 0xff) << 8)
        | (hmac[offset + 3] & 0xff);

    return String(binaryCode % (10 ** digits)).padStart(digits, "0");
}

export function verifyDevTotpCode({ code, secret, periodSeconds = 30, window = 1, digits = 6 }) {
    if (!/^\d{6}$/.test(String(code || ""))) {
        return false;
    }

    const secretBuffer = decodeBase32(secret);
    const nowCounter = Math.floor(Date.now() / 1000 / periodSeconds);

    for (let offset = -window; offset <= window; offset += 1) {
        const expected = generateTotp(secretBuffer, nowCounter + offset, digits);

        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code)))) {
            return true;
        }
    }

    return false;
}
