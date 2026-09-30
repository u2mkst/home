// students/attendance 전체 읽기 권한을 잠그기 전에, 기존 학생들의 랭킹용 공개 필드
// (name/schoolName/teacher, 이번 달까지의 출석 횟수)를 public_students /
// public_attendance_counts로 한 번 복사해두는 백필 스크립트.
//
// 실행 방법 (Firebase 서비스 계정 키가 있는 환경에서), 둘 중 편한 쪽으로:
//
//   1) 다운로드받은 JSON 키 파일 경로를 그대로 지정 (권장 — 셸에 긴 JSON을 직접
//      붙여넣지 않아도 됨):
//      cd backend
//      FIREBASE_SERVICE_ACCOUNT_PATH=/path/to/serviceAccountKey.json node scripts/backfill-public-students.js
//
//   2) JSON 내용을 환경변수 문자열로 직접 전달 (Vercel 등에 이미 문자열로
//      저장돼 있는 경우):
//      cd backend
//      FIREBASE_SERVICE_ACCOUNT='<서비스 계정 JSON 전체>' node scripts/backfill-public-students.js
//
// 이미 public_students/public_attendance_counts가 있는 경우에도 안전하게 덮어쓴다
// (같은 값이면 결과가 같음 — 멱등).

const admin = require("firebase-admin");
const fs = require("fs");

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    serviceAccount = JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));
} else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
    console.error("FIREBASE_SERVICE_ACCOUNT_PATH 또는 FIREBASE_SERVICE_ACCOUNT 환경변수가 필요합니다.");
    process.exit(1);
}
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://ksthome-76889-default-rtdb.firebaseio.com",
});

const db = admin.database();

async function backfillStudents() {
    const snap = await db.ref("students").once("value");
    const students = snap.val() || {};
    const updates = {};

    for (const uid of Object.keys(students)) {
        const s = students[uid];
        updates[`public_students/${uid}`] = {
            name: s.name || "",
            schoolName: s.schoolName || "",
            teacher: s.teacher || "",
        };
    }

    const count = Object.keys(updates).length;
    if (count === 0) {
        console.log("students 없음 — public_students 백필 건너뜀");
        return;
    }
    await db.ref().update(updates);
    console.log(`public_students 백필 완료: ${count}명`);
}

async function backfillAttendance() {
    const snap = await db.ref("attendance").once("value");
    const attendance = snap.val() || {};
    const updates = {};

    for (const uid of Object.keys(attendance)) {
        const months = attendance[uid] || {};
        for (const yearMonth of Object.keys(months)) {
            const count = months[yearMonth] && months[yearMonth].count;
            if (typeof count === "number") {
                updates[`public_attendance_counts/${uid}/${yearMonth}`] = count;
            }
        }
    }

    const count = Object.keys(updates).length;
    if (count === 0) {
        console.log("attendance 없음 — public_attendance_counts 백필 건너뜀");
        return;
    }
    await db.ref().update(updates);
    console.log(`public_attendance_counts 백필 완료: ${count}건`);
}

(async () => {
    try {
        await backfillStudents();
        await backfillAttendance();
        console.log("백필 완료.");
        process.exit(0);
    } catch (err) {
        console.error("백필 실패:", err);
        process.exit(1);
    }
})();
