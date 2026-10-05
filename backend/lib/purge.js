const { admin } = require("./firebaseAdmin");

// 학생과 관련된 DB 기록을 전부 지운다(Firebase Auth 계정 삭제는 호출자가 한다).
// 학생 본인의 탈퇴(api/account.js)와 마스터의 계정 삭제(api/admin.js)가 같이 쓴다.
async function purgeStudentData(uid) {
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
}

module.exports = { purgeStudentData };
