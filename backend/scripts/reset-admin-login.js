// 관리자·마스터 로그인 복구용 일회성 스크립트 (서비스 계정 키가 있는 사람만 실행할 수 있다).
// 관리자 로그인은 이제 서버가 비밀번호를 검증한다. 마스터 화면에 들어갈 수 없을 때(비밀번호를 잊었거나 둘 다 잠겼을 때)
// 이 스크립트로 새 비밀번호를 정하고 잠금을 풀 수 있다.
//
// 실행 (backend 폴더에서; 비밀번호는 명령줄 기록에 남지 않게 환경변수로 넘긴다):
//   FIREBASE_SERVICE_ACCOUNT_PATH=키파일.json AES_KEY=... PIN_PEPPER=... \
//   NEW_ADMIN_PASSWORD='12자 이상 영문+숫자 비밀번호' node scripts/reset-admin-login.js --email master@example.com
// ⚠️ PIN_PEPPER는 Vercel에 넣은 값과 같아야 한다(다르면 서버가 이 비밀번호를 검증하지 못한다).
const fs = require("fs");

if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH && !process.env.FIREBASE_SERVICE_ACCOUNT) {
    process.env.FIREBASE_SERVICE_ACCOUNT = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8");
}
for (const name of ["FIREBASE_SERVICE_ACCOUNT", "PIN_PEPPER", "NEW_ADMIN_PASSWORD"]) {
    if (!process.env[name]) { console.error(`${name} 환경변수가 필요합니다.`); process.exit(1); }
}
const emailIdx = process.argv.indexOf("--email");
const email = emailIdx >= 0 ? String(process.argv[emailIdx + 1] || "").trim().toLowerCase() : "";
if (!email) { console.error("--email <관리자 또는 마스터 이메일> 이 필요합니다."); process.exit(1); }
const pw = process.env.NEW_ADMIN_PASSWORD;
if (pw.length < 12 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    console.error("비밀번호는 12자 이상, 128자 이하이고 영문과 숫자를 모두 포함해야 합니다."); process.exit(1);
}

const { admin } = require("../lib/firebaseAdmin");
const { ADMIN_UIDS } = require("../lib/adminUids");
const { hashSecret } = require("../lib/pin");
const { randomAuthPassword } = require("../lib/authPassword");
const { dbKey } = require("../lib/guard");

(async () => {
    const user = await admin.auth().getUserByEmail(email);
    if (!ADMIN_UIDS.has(user.uid)) { console.error("관리자·마스터 계정이 아닙니다(학생 계정에는 쓸 수 없습니다)."); process.exit(1); }
    const ref = admin.database().ref(`loginSecrets/${user.uid}`);
    await ref.set({ ...hashSecret(pw), randomized: false, changedAt: admin.database.ServerValue.TIMESTAMP, changedBy: "script" });
    await admin.auth().updateUser(user.uid, { password: randomAuthPassword() });
    await ref.child("randomized").set(true);
    await admin.database().ref(`loginLockouts/${dbKey(`admin:${email}`)}`).remove();
    console.log(`완료: ${email} 의 비밀번호를 새로 정했고 잠금을 풀었습니다. 이제 이 비밀번호로 로그인하세요.`);
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
