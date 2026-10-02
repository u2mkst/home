const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { ADMIN_UIDS } = require("../lib/adminUids");
const { verifyPin, isValidPin } = require("../lib/pin");
const { normalizeLoginId, getLockout, registerFailure, clearLockout } = require("../lib/guard");

// 🔒 회원 탈퇴. 예전엔 클라이언트가 Firebase 비밀번호("00"+PIN)로 재인증한 뒤 students/{uid}만
// 지우고 계정을 삭제했다(나머지 기록은 고아로 남음). 이제 PIN을 서버가 검증(락아웃 적용)하고,
// 이 학생과 관련된 기록을 전부 지운 뒤 계정을 삭제한다.
module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        const decoded = await requireAuth(req);
        const uid = decoded.uid;
        if (ADMIN_UIDS.has(uid)) return res.status(403).json({ error: "forbidden" });

        const { pin } = req.body || {};
        if (!isValidPin(pin)) return res.status(400).json({ error: "bad_request" });

        const userRecord = await admin.auth().getUser(uid);
        const normalizedId = normalizeLoginId(userRecord.email);
        if (!normalizedId) return res.status(400).json({ error: "bad_request" });

        const lockout = await getLockout(normalizedId);
        if ((lockout.lockedUntil || 0) > Date.now()) {
            return res.status(429).json({ error: "locked", lockedUntil: lockout.lockedUntil });
        }

        const secretSnap = await admin.database().ref(`loginSecrets/${uid}`).once("value");
        if (!verifyPin(pin, secretSnap.val())) {
            const state = await registerFailure(normalizedId);
            return res.status(401).json({ error: "invalid", lockedUntil: state.lockedUntil > Date.now() ? state.lockedUntil : 0 });
        }
        await clearLockout(normalizedId);

        const db = admin.database();
        const updates = {};
        for (const path of [
            "students", "public_students", "loginSecrets", "attendance", "public_attendance_counts",
            "mathQuizProgress", "studentAchievements", "device_status", "student_messages",
        ]) {
            updates[`${path}/${uid}`] = null;
        }

        // 로또 예측(회차별), 학생이 보낸 메시지/건의사항
        const [lottoSnap, msgSnap, sugSnap] = await Promise.all([
            db.ref("lotto_predictions").once("value"),
            db.ref("messages").orderByChild("studentUid").equalTo(uid).once("value"),
            db.ref("suggestions").once("value"),
        ]);
        Object.keys(lottoSnap.val() || {}).forEach((round) => { updates[`lotto_predictions/${round}/${uid}`] = null; });
        Object.keys(msgSnap.val() || {}).forEach((key) => { updates[`messages/${key}`] = null; });
        const suggestions = sugSnap.val() || {};
        Object.keys(suggestions).forEach((key) => {
            if (suggestions[key] && suggestions[key].studentUid === uid) updates[`suggestions/${key}`] = null;
        });

        await db.ref().update(updates);
        await admin.auth().deleteUser(uid);
        return res.status(200).json({ ok: true });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
