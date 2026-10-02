const { admin } = require("./firebaseAdmin");

// 서버가 지급하는 업적(출석/로또). 퀴즈 업적(quiz_*)은 클라이언트가 직접 기록한다.
// 임계값은 index.html의 ACHIEVEMENTS 정의와 같아야 한다.
const ATTENDANCE_BADGES = [
    { id: "att_1", threshold: 1 },
    { id: "att_30", threshold: 30 },
    { id: "att_100", threshold: 100 },
];
const LOTTO_BADGES = [
    { id: "lotto_3", threshold: 3 },
    { id: "lotto_5", threshold: 5 },
];

// 이미 지급된 건 건드리지 않고(다시 쓰지 않음), 새로 달성한 것만 기록한다.
function badgeUpdates(uid, existing, badges, value) {
    const updates = {};
    for (const b of badges) {
        if (value >= b.threshold && !(existing && existing[b.id])) {
            updates[`studentAchievements/${uid}/${b.id}`] = true;
        }
    }
    return updates;
}

async function grantAttendanceBadges(uid) {
    const [attSnap, achSnap] = await Promise.all([
        admin.database().ref(`attendance/${uid}`).once("value"),
        admin.database().ref(`studentAchievements/${uid}`).once("value"),
    ]);
    const total = Object.values(attSnap.val() || {}).reduce((sum, m) => sum + ((m && m.count) || 0), 0);
    const updates = badgeUpdates(uid, achSnap.val(), ATTENDANCE_BADGES, total);
    if (Object.keys(updates).length) await admin.database().ref().update(updates);
    return total;
}

// 로또 판정 결과로 지급할 업적 경로들을 모아 돌려준다(호출자가 한 번에 update).
function lottoBadgeUpdates(uid, existing, matchedCount) {
    return badgeUpdates(uid, existing, LOTTO_BADGES, matchedCount);
}

module.exports = { grantAttendanceBadges, lottoBadgeUpdates };
