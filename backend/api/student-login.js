const { applyCors } = require("../lib/cors");
const { admin } = require("../lib/firebaseAdmin");
const { ADMIN_UIDS } = require("../lib/adminUids");
const { hashPin, verifyPin, isValidPin } = require("../lib/pin");
const { randomAuthPassword } = require("../lib/authPassword");
const {
    normalizeLoginId,
    toLoginEmail,
    isBotSuspected,
    getLockout,
    beginAttempt,
    clearLockout,
    consumeIpQuota,
    isIpQuotaExceeded,
} = require("../lib/guard");
const { verifyFirebasePassword } = require("../lib/firebaseRest");
const { handleAdminLogin } = require("../lib/adminLogin");

// 🔒 학생 로그인 — PIN(부모님 전화번호 뒷 4자리, 경우의 수 1만)을 Firebase Auth 비밀번호로 쓰면
// Firebase REST API를 직접 두드리는 무차별 대입을 우리가 막을 방법이 없다. 그래서 학생의
// Firebase 비밀번호는 아무도 모르는 무작위 값으로 바꿔두고, PIN은 이 서버에서만(해시로)
// 검증한다. 검증 전에 계정별 락아웃 / IP별 한도 / reCAPTCHA를 서버가 강제하고, 통과하면
// Firebase 커스텀 토큰을 발급해 클라이언트가 signInWithCustomToken으로 로그인한다.
//
// 아직 이전되지 않은 기존 계정은 첫 로그인 때 Firebase REST로 "00"+PIN을 한 번 검증해(진실의
// 원천) PIN 해시를 저장하고 Firebase 비밀번호를 무작위 값으로 바꾼다(지연 이전).
const IP_LOGIN_LIMIT = 300;                 // IP당 시간당 로그인 시도(학원 와이파이 공유 감안)
const IP_LOGIN_FAIL_LIMIT = 40;             // IP당 시간당 "실패한" 로그인 — 여러 계정에 흔한 PIN을 돌려 보는 공격(스프레이)을 막는다
const IP_LOGIN_NOTOKEN_LIMIT = 40;          // reCAPTCHA 토큰 없는 요청의 IP당 시간당 한도
const IP_WINDOW_MS = 60 * 60 * 1000;

const DUMMY_SECRET = { salt: "00".repeat(16), hash: "00".repeat(32) };

async function verifyLegacyPasswordViaRest(email, pin) {
    return verifyFirebasePassword(email, `00${pin}`);
}

// 로그인 실패를 응답하면서 IP별 "실패" 횟수도 센다.
async function sendInvalid(req, res, lockout) {
    try { await consumeIpQuota(req, "login-fail", IP_LOGIN_FAIL_LIMIT, IP_WINDOW_MS); } catch (e) { /* 세지 못해도 응답은 한다 */ }
    return res.status(401).json({
        error: "invalid",
        lockedUntil: lockout && lockout.lockedUntil > Date.now() ? lockout.lockedUntil : 0,
    });
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        // 관리자·마스터 로그인도 같은 엔드포인트(Vercel 함수 12개 제한): body.admin === true
        if (req.body && req.body.admin === true) return await handleAdminLogin(req, res);

        const { id, pin, recaptchaToken } = req.body || {};
        const normalizedId = normalizeLoginId(id);
        if (!normalizedId || !isValidPin(pin)) {
            return res.status(400).json({ error: "bad_request" });
        }

        const quota = await consumeIpQuota(req, "login", IP_LOGIN_LIMIT, IP_WINDOW_MS);
        if (!quota.allowed) {
            return res.status(429).json({ error: "ip_limited", retryAfterMs: quota.retryAfterMs });
        }

        const failed = await isIpQuotaExceeded(req, "login-fail", IP_LOGIN_FAIL_LIMIT);
        if (failed.exceeded) {
            res.setHeader("Retry-After", String(Math.ceil(failed.retryAfterMs / 1000)));
            return res.status(429).json({ error: "ip_limited", retryAfterMs: failed.retryAfterMs });
        }

        const lockout = await getLockout(normalizedId);
        if ((lockout.lockedUntil || 0) > Date.now()) {
            return res.status(429).json({ error: "locked", lockedUntil: lockout.lockedUntil });
        }

        // reCAPTCHA 토큰이 없으면(구글 스크립트 차단 등) 로그인은 허용하되, 토큰 없이 직접 API를 두드리는
        // 자동화 공격을 줄이기 위해 훨씬 낮은 IP 한도를 적용한다.
        if (!recaptchaToken) {
            const strict = await consumeIpQuota(req, "login-notoken", IP_LOGIN_NOTOKEN_LIMIT, IP_WINDOW_MS);
            if (!strict.allowed) return res.status(429).json({ error: "ip_limited", retryAfterMs: strict.retryAfterMs });
        }
        if (await isBotSuspected(recaptchaToken, "login")) {
            return res.status(403).json({ error: "bot" });
        }

        const email = toLoginEmail(normalizedId);
        let userRecord = null;
        try {
            userRecord = await admin.auth().getUserByEmail(email);
        } catch (e) {
            userRecord = null;
        }

        // 존재하지 않는 아이디/관리자 계정은 학생 로그인 경로로 들어올 수 없다. 응답 시간으로
        // 계정 존재 여부를 눈치채지 못하도록 더미 검증을 한 번 돌린다.
        if (!userRecord || ADMIN_UIDS.has(userRecord.uid)) {
            verifyPin(pin, DUMMY_SECRET);
            return sendInvalid(req, res, null);
        }

        // PIN을 맞춰보기 전에 시도를 원자적으로 센다(병렬 요청으로 횟수 제한을 피하지 못하게).
        const attempt = await beginAttempt(normalizedId);
        if (!attempt.allowed) {
            return res.status(429).json({ error: "locked", lockedUntil: attempt.state.lockedUntil || 0 });
        }

        const uid = userRecord.uid;
        const secretRef = admin.database().ref(`loginSecrets/${uid}`);
        const secretSnap = await secretRef.once("value");
        const secret = secretSnap.val();

        let ok = false;
        let randomized = Boolean(secret && secret.randomized);
        if (secret) {
            ok = verifyPin(pin, secret);
        } else {
            const legacy = await verifyLegacyPasswordViaRest(email, pin);
            if (legacy.throttled) {
                return res.status(429).json({ error: "locked", lockedUntil: Date.now() + 60 * 1000 });
            }
            ok = legacy.ok;
            // 지연 이전: PIN 해시를 먼저 저장해 두면 이후엔 해시로 로그인된다.
            if (ok) await secretRef.set({ ...hashPin(pin), migratedAt: admin.database.ServerValue.TIMESTAMP });
        }

        // Firebase 비밀번호를 무작위 값으로 바꾸는 건 "로그인 성공 뒤에" best-effort로 한다 — 실패해도
        // (정책 오류 등) 로그인을 막지 않고, randomized 표시가 없으면 다음 로그인 때 다시 시도한다.
        if (ok && !randomized) {
            try {
                await admin.auth().updateUser(uid, { password: randomAuthPassword() });
                await secretRef.child("randomized").set(true);
            } catch (e) {
                console.error("Firebase 비밀번호 무작위화 실패:", uid, e.message);
            }
        }

        if (!ok) return sendInvalid(req, res, attempt.state);

        if (userRecord.disabled) return res.status(403).json({ error: "disabled" });
        await clearLockout(normalizedId);
        const token = await admin.auth().createCustomToken(uid);
        return res.status(200).json({ token });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
