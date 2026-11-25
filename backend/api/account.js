const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { encryptOne } = require("../lib/aes");
const { ADMIN_UIDS } = require("../lib/adminUids");
const { hashPin, verifyPin, isValidPin } = require("../lib/pin");
const { purgeStudentData } = require("../lib/purge");
const { normalizeLoginId, beginAttempt, clearLockout, rejectIfRateLimited } = require("../lib/guard");
const { getStudentScores } = require("../lib/studentScores");

// 로그인한 학생 본인의 계정 관리(PIN 변경 / 회원 탈퇴).
// ※ Vercel 무료(Hobby) 플랜은 서버 함수를 12개까지만 배포할 수 있어서 한 파일로 묶었다.
//
// 학생의 Firebase 비밀번호는 무작위 값이고 PIN(부모님 전화번호 뒷 4자리) 검증은 서버가 한다.
//  - set-pin : PIN 해시와 암호화된 phone 필드를 서버가 같이 갱신(로그인한 지 1시간 이내만 허용)
//  - delete  : PIN을 서버가 검증(락아웃 적용)한 뒤, 학생과 관련된 기록을 전부 지우고 계정 삭제
//  - scores  : 본인 시험 성적(노션)을 읽어서 돌려준다(본인 점수 + 그 시험의 평균/최고/최저만)
const RECENT_LOGIN_SECONDS = 60 * 60;

async function setPin(decoded, body, res) {
    if (decoded.auth_time && Date.now() / 1000 - decoded.auth_time > RECENT_LOGIN_SECONDS) {
        return res.status(401).json({ error: "recent_login_required" });
    }
    if (!isValidPin(body.pin)) return res.status(400).json({ error: "bad_request" });

    // salt/hash만 갈아끼운다(randomized 같은 다른 표시는 그대로 둔다).
    const { salt, hash } = hashPin(body.pin);
    await admin.database().ref().update({
        [`loginSecrets/${decoded.uid}/salt`]: salt,
        [`loginSecrets/${decoded.uid}/hash`]: hash,
        [`loginSecrets/${decoded.uid}/migratedAt`]: admin.database.ServerValue.TIMESTAMP,
        [`students/${decoded.uid}/phone`]: encryptOne(process.env.AES_KEY, body.pin),
    });
    return res.status(200).json({ ok: true });
}

async function deleteAccount(decoded, body, res) {
    const uid = decoded.uid;
    if (!isValidPin(body.pin)) return res.status(400).json({ error: "bad_request" });

    const userRecord = await admin.auth().getUser(uid);
    const normalizedId = normalizeLoginId(userRecord.email);
    if (!normalizedId) return res.status(400).json({ error: "bad_request" });

    const attempt = await beginAttempt(normalizedId);
    if (!attempt.allowed) {
        return res.status(429).json({ error: "locked", lockedUntil: attempt.state.lockedUntil || 0 });
    }

    const secretSnap = await admin.database().ref(`loginSecrets/${uid}`).once("value");
    if (!verifyPin(body.pin, secretSnap.val())) {
        return res.status(401).json({ error: "invalid", lockedUntil: attempt.state.lockedUntil > Date.now() ? attempt.state.lockedUntil : 0 });
    }
    await clearLockout(normalizedId);

    await purgeStudentData(uid);
    await admin.auth().deleteUser(uid);
    return res.status(200).json({ ok: true });
}

// 본인 시험 성적. 노션 토큰/연동 문제는 학생에게 세부 원인을 알리지 않고, 로그에는 오류 코드만 남긴다.
async function sendScores(req, decoded, res) {
    res.setHeader("Cache-Control", "no-store");
    if (await rejectIfRateLimited(req, res, "scores", 300, 60 * 60 * 1000)) return;
    try {
        return res.status(200).json(await getStudentScores(decoded.uid));
    } catch (err) {
        if (err && err.name === "NotionError") {
            console.error("scores notion error:", err.notionCode);
            return err.notionCode === "not_configured"
                ? res.status(503).json({ error: "not_configured" })
                : res.status(502).json({ error: "notion_unavailable" });
        }
        throw err;
    }
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        const decoded = await requireAuth(req);
        if (ADMIN_UIDS.has(decoded.uid)) return res.status(403).json({ error: "forbidden" });

        const body = req.body || {};
        if (body.action === "set-pin") return await setPin(decoded, body, res);
        if (body.action === "delete") return await deleteAccount(decoded, body, res);
        if (body.action === "scores") return await sendScores(req, decoded, res);
        return res.status(400).json({ error: "bad_action" });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
