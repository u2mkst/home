const { applyCors } = require("../lib/cors");

// 배포 후 필수 환경변수가 들어갔는지만 확인하는 점검용 엔드포인트(값은 절대 노출하지 않는다).
module.exports = (req, res) => {
    if (applyCors(req, res)) return;
    const has = (name, minLen = 1) => Boolean(process.env[name] && process.env[name].length >= minLen);
    res.status(200).json({
        AES_KEY: has("AES_KEY"),
        FIREBASE_SERVICE_ACCOUNT: has("FIREBASE_SERVICE_ACCOUNT"),
        PIN_PEPPER: has("PIN_PEPPER", 32),
        RECAPTCHA_V3_SECRET_KEY: has("RECAPTCHA_V3_SECRET_KEY"),
        CRON_SECRET: has("CRON_SECRET", 16),
        ALLOWED_ORIGIN: has("ALLOWED_ORIGIN"),
        NEIS_API_KEY: has("NEIS_API_KEY"),
    });
};
