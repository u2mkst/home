const { applyCors } = require("../lib/cors");

// 배포 점검용 엔드포인트. 누구나 부르는 공개 주소에서는 "살아있다"만 알려주고,
// 어떤 보안 설정이 켜져 있는지(환경변수 유무)는 마스터 계정으로 로그인한 요청에만 보여준다(값은 절대 노출하지 않음).
// 같은 정보는 마스터 화면의 "시스템 상태"에서도 볼 수 있다.
module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    let detail = null;
    try {
        if ((req.headers.authorization || "").startsWith("Bearer ")) {
            const { requireAuth } = require("../lib/firebaseAdmin");
            const { MASTER_UIDS } = require("../lib/adminUids");
            const decoded = await requireAuth(req);
            if (MASTER_UIDS.has(decoded.uid)) {
                const has = (name, minLen = 1) => Boolean(process.env[name] && process.env[name].length >= minLen);
                detail = {
                    AES_KEY: has("AES_KEY"),
                    AES_KEY_STRONG: has("AES_KEY", 32),
                    AES_KEY_OLD: has("AES_KEY_OLD"), // 키 교체 중에만 true여야 함
                    FIREBASE_SERVICE_ACCOUNT: has("FIREBASE_SERVICE_ACCOUNT"),
                    PIN_PEPPER: has("PIN_PEPPER", 32),
                    RECAPTCHA_V3_SECRET_KEY: has("RECAPTCHA_V3_SECRET_KEY"),
                    CRON_SECRET: has("CRON_SECRET", 16),
                    ALLOWED_ORIGIN: has("ALLOWED_ORIGIN"),
                    NEIS_API_KEY: has("NEIS_API_KEY"),
                };
            }
        }
    } catch (e) { /* 토큰이 없거나 잘못됐으면 공개 응답만 */ }
    res.status(200).json(detail ? { ok: true, ...detail } : { ok: true });
};
