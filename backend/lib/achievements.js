const { admin } = require("./firebaseAdmin");

// 서버가 지급하는 업적(출석/로또). 퀴즈 업적(quiz_*)은 클라이언트가 직접 기록한다.
// 임계값은 index.html의 ACHIEVEMENTS 정의와 같아야 한다.
const ATTENDANCE_BADGES = [
    { id: "att_1", threshold: 1 },
    { id: "att_30", threshold: 30 },
    { id: "att_100", threshold: 100 },
];
// (5개 이상 적중 배지는 확률이 너무 낮아 없앴다. 이미 받은 학생의 기록은 그대로 남지만 화면에는 표시하지 않는다.)
const LOTTO_BADGES = [
    { id: "lotto_3", threshold: 3 },
];
const STREAK_BADGE = { id: "lotto_streak4", rounds: 4 };

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

// 판정 결과 중 "보너스 번호 적중" 배지
function lottoBonusBadgeUpdates(uid, existing, bonusHit) {
    if (bonusHit && !(existing && existing.lotto_bonus)) return { [`studentAchievements/${uid}/lotto_bonus`]: true };
    return {};
}

// 예측을 제출하는 순간 지급하는 참여 배지: 첫 참여(lotto_first), 4주 연속 참여(lotto_streak4).
async function grantLottoParticipationBadges(uid, round) {
    const db = admin.database();
    const prevRounds = [round - 1, round - 2, round - 3].filter((r) => r >= 1);
    const [achSnap, ...prevSnaps] = await Promise.all([
        db.ref(`studentAchievements/${uid}`).once("value"),
        ...prevRounds.map((r) => db.ref(`lotto_predictions/${r}/${uid}`).once("value")),
    ]);
    const existing = achSnap.val() || {};
    const updates = {};
    if (!existing.lotto_first) updates[`studentAchievements/${uid}/lotto_first`] = true;
    const streakOk = prevRounds.length === STREAK_BADGE.rounds - 1 && prevSnaps.every((snap) => snap.val() !== null);
    if (streakOk && !existing[STREAK_BADGE.id]) updates[`studentAchievements/${uid}/${STREAK_BADGE.id}`] = true;
    if (Object.keys(updates).length) await db.ref().update(updates);
    return Object.keys(updates);
}

module.exports = { grantAttendanceBadges, lottoBadgeUpdates, lottoBonusBadgeUpdates, grantLottoParticipationBadges };
