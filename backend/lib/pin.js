const crypto = require("crypto");

// 학생 PIN(부모님 전화번호 뒷 4자리)은 경우의 수가 1만뿐이라, 해시를 훔쳐가도 오프라인으로
// 바로 뚫린다. 그래서 (1) 사용자별 salt + (2) 서버에만 있는 PIN_PEPPER를 함께 넣어
// scrypt로 해시한다 — DB가 유출돼도 PIN_PEPPER까지 같이 털리지 않으면 대입이 불가능하다.
function getPepper() {
    const pepper = process.env.PIN_PEPPER;
    if (!pepper || pepper.length < 32) {
        const err = new Error("서버 설정 오류: PIN_PEPPER 환경변수(32자 이상)가 필요합니다");
        err.statusCode = 500;
        throw err;
    }
    return pepper;
}

function derive(pin, saltHex) {
    return crypto.scryptSync(`${getPepper()}:${pin}`, Buffer.from(saltHex, "hex"), 32, { N: 16384, r: 8, p: 1 });
}

function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString("hex");
    return { salt, hash: derive(String(pin), salt).toString("hex") };
}

function verifyPin(pin, record) {
    if (!record || !record.salt || !record.hash) return false;
    const expected = Buffer.from(record.hash, "hex");
    const actual = derive(String(pin), record.salt);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function isValidPin(pin) {
    return typeof pin === "string" && /^\d{4}$/.test(pin);
}

module.exports = { hashPin, verifyPin, isValidPin };
