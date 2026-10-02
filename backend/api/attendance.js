const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { kstDateParts } = require("../lib/kst");
const { grantAttendanceBadges } = require("../lib/achievements");

// 🔒 출석 체크. 예전엔 클라이언트가 attendance/{uid}에 날짜와 횟수를 직접 써서, 학생이 이번 달
// 날짜를 전부 써넣거나 횟수를 마음대로 올릴 수 있었다. 이제 서버가 "서버 시각 기준 오늘"만
// 기록하고, 랭킹용 공개 횟수와 출석 업적도 서버가 갱신한다(학생 쓰기 권한은 규칙에서 막힘).
module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    try {
        const { uid } = await requireAuth(req);
        const { yearMonth, date } = kstDateParts();
        const monthRef = admin.database().ref(`attendance/${uid}/${yearMonth}`);

        const result = await monthRef.transaction((current) => {
            const data = current || {};
            const days = data.days || {};
            if (days[date]) return; // 오늘은 이미 기록됨 → 변경 없음(트랜잭션 취소)
            days[date] = true;
            return { days, count: Object.keys(days).length, lastAttendance: Date.now() };
        });

        const month = result.snapshot.val() || { count: 0 };
        await admin.database().ref(`public_attendance_counts/${uid}/${yearMonth}`).set(month.count || 0);
        const total = await grantAttendanceBadges(uid);
        return res.status(200).json({ ok: true, date, count: month.count || 0, total, newlyRecorded: result.committed });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
