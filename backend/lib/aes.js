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

// 🔑 키 교체 중에는 새 키(AES_KEY)와 옛 키(AES_KEY_OLD)가 같이 있다. 암호화는 항상 새 키로 하고,
// 복호화는 새 키 → 옛 키 순서로 시도한다(교체가 끝나면 AES_KEY_OLD를 지운다).
function getDecryptKeys() {
    return [process.env.AES_KEY, process.env.AES_KEY_OLD].filter(Boolean);
}

// 틀린 키로 풀면 대개 UTF-8 변환 오류나 빈 값이 나오지만, 아주 드물게 "그럴듯한 쓰레기"가 나올 수
// 있어서 제어문자/깨짐 문자가 섞였는지도 본다(이름·전화번호·비밀번호·메시지는 모두 일반 텍스트).
function isPlausibleText(text) {
    return typeof text === "string" && text.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text);
}

// CryptoJS는 복호화 뒤 PKCS7 패딩이 올바른지 검사하지 않아서, 틀린 키로 풀어도 "그럴듯한 쓰레기"가
// 0.6% 정도 나온다(키 교체 중 틀린 키가 성공으로 오판되면 데이터가 조용히 망가진다). 그래서 패딩을
// 직접 검증한다 — 올바른 키가 아니면 마지막 n바이트가 모두 n이 될 확률이 극히 낮다.
function stripValidPkcs7(wordArray) {
    const total = wordArray.sigBytes;
    if (total < 16 || total % 16 !== 0) return null;
    const byteAt = (i) => (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
    const n = byteAt(total - 1);
    if (n < 1 || n > 16) return null;
    for (let k = 1; k <= n; k++) {
        if (byteAt(total - k) !== n) return null;
    }
    wordArray.sigBytes = total - n;
    wordArray.clamp();
    return wordArray;
}

// 한 겹을 벗긴다. 성공하면 { plain, keyIndex }, 어떤 키로도 안 풀리면 null.
function decryptLayer(keys, clean) {
    for (let i = 0; i < keys.length; i++) {
        try {
            const raw = CryptoJS.AES.decrypt(clean, keys[i], { padding: CryptoJS.pad.NoPadding });
            const unpadded = stripValidPkcs7(raw);
            if (!unpadded) continue;
            const plain = unpadded.toString(CryptoJS.enc.Utf8);
            // 빈 문자열을 암호화한 값(예: 건의사항에서 비워둔 "인물 설명")은 패딩 16바이트뿐인 한 블록이라
            // 복호화하면 ''가 나온다. 틀린 키가 우연히 이 패딩(0x10이 16개)을 만들 확률은 2^-128이므로
            // 패딩이 정확히 맞은 빈 값은 정상으로 인정한다.
            if (plain === "" && unpadded.sigBytes === 0) return { plain, keyIndex: i };
            if (isPlausibleText(plain)) return { plain, keyIndex: i };
        } catch (e) {
            // 이 키로는 안 풀림 → 다음 키
        }
    }
    return null;
}

// 과거 버그로 이미 평문이 한 번 더 암호화되어("이중 암호화") 저장된 값이 있을 수 있다. 한 겹만
// 벗겨서 여전히 암호문 형태(U2FsdGVkX1...)면 평문이 나올 때까지 반복해서 벗겨낸다.
// 반환: { plain, ok, layers, keyIndexes } — ok=false면 plain은 벗기다 만 암호문(원본 동작과 동일).
function decryptDetailed(keyOrKeys, cipherText) {
    const keys = (Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]).filter(Boolean);
    if (!cipherText) return { plain: "", ok: true, layers: 0, keyIndexes: [] };

    let current = String(cipherText).trim();
    const keyIndexes = [];
    for (let i = 0; i < MAX_DECRYPT_LAYERS; i++) {
        // 저장 과정에서 따옴표가 붙거나 '+'가 공백으로 바뀐 "암호문"을 복구해서 암호문인지 판단한다.
        // ⚠️ 이 보정은 암호문 후보를 확인하는 용도로만 쓰고, 평문에는 절대 적용하지 않는다 —
        // (예전엔 복호화된 평문에도 공백→'+' 치환을 해서 공백이 있는 메시지가 "안녕+하세요"로 나갔다.)
        let clean = current;
        if (clean.startsWith('"') && clean.endsWith('"')) clean = clean.slice(1, -1);
        else if (clean.startsWith("'") && clean.endsWith("'")) clean = clean.slice(1, -1);
        clean = clean.replace(/ /g, "+");

        if (!clean.startsWith(CIPHER_PREFIX)) {
            return { plain: current, ok: true, layers: keyIndexes.length, keyIndexes }; // 이미 평문
        }
        const layer = decryptLayer(keys, clean);
        if (!layer) return { plain: current, ok: false, layers: keyIndexes.length, keyIndexes };
        keyIndexes.push(layer.keyIndex);
        current = layer.plain;
    }
    // 5겹을 벗겨도 여전히 암호문 형태면 포기하고 마지막 상태를 반환
    return { plain: current, ok: !current.startsWith(CIPHER_PREFIX), layers: keyIndexes.length, keyIndexes };
}

function decryptOne(keyOrKeys, cipherText) {
    return decryptDetailed(keyOrKeys, cipherText).plain;
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

module.exports = { encryptOne, decryptOne, decryptDetailed, getDecryptKeys, assertValidBatch, CIPHER_PREFIX };
