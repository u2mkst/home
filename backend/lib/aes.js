const CryptoJS = require("crypto-js");

const MAX_BATCH = 200;

const CIPHER_PREFIX = "U2FsdGVkX1";

// 클라이언트 쪽 버그(복호화 실패 값을 화면에 남긴 채 재저장 등)로 인해 이미
// 암호문 형태인 문자열이 "평문"으로 암호화 요청에 들어올 수 있다. 그걸 그대로
// 다시 암호화하면 이중 암호화 사고가 재발하므로, 이미 우리 형식의 암호문처럼
// 보이는 입력은 한 번 더 감싸지 않고 그대로 통과시킨다(멱등). 정상적인 평문이
// 우연히 이 접두사로 시작할 확률은 사실상 0이다.
function encryptOne(key, plainText) {
    if (plainText === null || plainText === undefined) return "";
    const str = String(plainText).trim();
    if (str.startsWith(CIPHER_PREFIX)) return str;
    return CryptoJS.AES.encrypt(str, key).toString();
}

const MAX_DECRYPT_LAYERS = 5;

// 과거 버그로 인해 이미 평문이 한 번 더 암호화되어("이중 암호화") 저장된 값이
// 있을 수 있다. 한 겹만 벗겨서 여전히 암호문 형태(U2FsdGVkX1...)면 평문이 나올
// 때까지 반복해서 벗겨낸다 — 정상적인 단일 암호화 값은 1회 만에 끝나므로 기존
// 동작에는 영향이 없다.
function decryptOne(key, cipherText) {
    if (!cipherText) return "";
    let current = String(cipherText).trim();
    for (let i = 0; i < MAX_DECRYPT_LAYERS; i++) {
        let clean = current;
        if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
        else if (clean.startsWith("'") && clean.endsWith("'")) clean = clean.slice(1, -1);
        clean = clean.replace(/ /g, "+");

        if (!clean.startsWith(CIPHER_PREFIX)) return clean; // already plaintext, matches old client fallback

        try {
            const bytes = CryptoJS.AES.decrypt(clean, key);
            const plain = bytes.toString(CryptoJS.enc.Utf8);
            if (!plain) return current;
            current = plain;
        } catch (e) {
            return current;
        }
    }
    return current; // 5겹을 벗겨도 여전히 암호문 형태면 포기하고 마지막 상태를 반환
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
