const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { encryptOne } = require("../lib/aes");
const { ADMIN_UIDS } = require("../lib/adminUids");
const { hashPin, isValidPin } = require("../lib/pin");

// 🔒 학생이 마이페이지에서 부모님 전화번호(=로그인 PIN)를 바꿀 때 호출한다. 예전엔
// 클라이언트가 user.updatePassword("00"+PIN)을 직접 호출했지만, 이제 Firebase 비밀번호는
// 무작위 값이고 PIN 검증은 서버가 하므로 PIN 해시와 암호화된 phone 필드를 서버가 같이 갱신한다.
const RECENT_LOGIN_SECONDS = 60 * 60; // 로그인한 지 1시간 이내일 때만 변경 허용

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        const decoded = await requireAuth(req);
        if (ADMIN_UIDS.has(decoded.uid)) {
            return res.status(403).json({ error: "forbidden" });
        }
        if (decoded.auth_time && Date.now() / 1000 - decoded.auth_time > RECENT_LOGIN_SECONDS) {
            return res.status(401).json({ error: "recent_login_required" });
        }

        const { pin } = req.body || {};
        if (!isValidPin(pin)) {
            return res.status(400).json({ error: "bad_request" });
        }

        await admin.database().ref().update({
            [`loginSecrets/${decoded.uid}`]: { ...hashPin(pin), migratedAt: admin.database.ServerValue.TIMESTAMP },
            [`students/${decoded.uid}/phone`]: encryptOne(process.env.AES_KEY, pin),
        });
        return res.status(200).json({ ok: true });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
