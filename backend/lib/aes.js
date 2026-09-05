const CryptoJS = require("crypto-js");

const MAX_BATCH = 200;

function encryptOne(key, plainText) {
    if (plainText === null || plainText === undefined) return "";
    return CryptoJS.AES.encrypt(String(plainText).trim(), key).toString();
}

function decryptOne(key, cipherText) {
    if (!cipherText) return "";
    try {
        let clean = String(cipherText).trim();
        if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
        else if (clean.startsWith("'") && clean.endsWith("'")) clean = clean.slice(1, -1);
        clean = clean.replace(/ /g, "+");

        if (!clean.startsWith("U2FsdGVkX1")) return clean; // already plaintext, matches old client fallback

        const bytes = CryptoJS.AES.decrypt(clean, key);
        const plain = bytes.toString(CryptoJS.enc.Utf8);
        return plain || cipherText;
    } catch (e) {
        return cipherText;
    }
}

function assertValidBatch(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
        const err = new Error("`texts` must be a non-empty array");
        err.statusCode = 400;
        throw err;
    }
    if (texts.length > MAX_BATCH) {
        const err = new Error(`\`texts\` cannot exceed ${MAX_BATCH} items`);
        err.statusCode = 400;
        throw err;
    }
}

module.exports = { encryptOne, decryptOne, assertValidBatch };
