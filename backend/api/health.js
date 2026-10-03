const { applyCors } = require("../lib/cors");

// 배포 후 필수 환경변수가 들어갔는지만 확인하는 점검용 엔드포인트(값은 절대 노출하지 않는다).
module.exports = (req, res) => {
    if (applyCors(req, res)) return;
    const has = (name, minLen = 1) => Boolean(process.env[name] && process.env[name].length >= minLen);
    res.status(200).json({
        AES_KEY: has("AES_KEY"),
        AES_KEY_STRONG: has("AES_KEY", 32),   // 32자 이상(공개된 옛 키 u2mkst!가 아님)
        AES_KEY_OLD: has("AES_KEY_OLD"),      // 키 교체 중에만 true여야 함(교체 완료 후 삭제)
        FIREBASE_SERVICE_ACCOUNT: has("FIREBASE_SERVICE_ACCOUNT"),
        PIN_PEPPER: has("PIN_PEPPER", 32),
        RECAPTCHA_V3_SECRET_KEY: has("RECAPTCHA_V3_SECRET_KEY"),
        CRON_SECRET: has("CRON_SECRET", 16),
        ALLOWED_ORIGIN: has("ALLOWED_ORIGIN"),
        NEIS_API_KEY: has("NEIS_API_KEY"),
    });
};
