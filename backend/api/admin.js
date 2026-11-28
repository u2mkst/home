const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { MASTER_UIDS, ADMIN_UIDS } = require("../lib/adminUids");
const { encryptOne, decryptOne, getDecryptKeys } = require("../lib/aes");
const { hashPin, isValidPin } = require("../lib/pin");
const { randomAuthPassword } = require("../lib/authPassword");
const { dbKey, normalizeLoginId } = require("../lib/guard");
const { kstDateParts } = require("../lib/kst");
const { grantAttendanceBadges } = require("../lib/achievements");
const { purgeStudentData } = require("../lib/purge");
const lotto = require("./lotto");
const tabletSites = require("../lib/tabletSites");
const authMigration = require("../lib/authMigration");
const { hashSecret } = require("../lib/pin");

// 🛠️ 마스터 전용 운영 도구. 학생 계정/잠금/PIN/출석/로또처럼 클라이언트 규칙으로는 열어줄 수 없는
// (서버만 쓸 수 있는) 데이터를 마스터 화면에서 다루기 위한 단일 엔드포인트다.
// ※ Vercel 무료(Hobby) 플랜의 서버 함수 12개 제한 때문에 기능을 action으로 묶었다.
// 마스터 UID가 아니면(관리자 admin@kst.com 포함) 모두 403.
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(status, error) {
    const err = new Error(error);
    err.statusCode = status;
    return err;
}

function needUid(body) {
    if (typeof body.uid !== "string" || !UID_RE.test(body.uid)) throw fail(400, "bad_uid");
    if (ADMIN_UIDS.has(body.uid)) throw fail(403, "admin_account");
    return body.uid;
}

function isRealDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function safePlain(cipher) {
    if (!cipher || typeof cipher !== "string") return "";
    const plain = decryptOne(getDecryptKeys(), cipher);
    return plain.startsWith("U2FsdGVkX1") ? "" : plain; // 못 푼 암호문은 노출하지 않는다
}

// ---------- 잠금 ----------
async function listLocks() {
    const val = (await admin.database().ref("loginLockouts").once("value")).val() || {};
    const now = Date.now();
    const rows = Object.entries(val).map(([key, s]) => ({
        id: decodeURIComponent(key),
        failCount: (s && s.failCount) || 0,
        lockedUntil: (s && s.lockedUntil) || 0,
        lastFailAt: (s && s.lastFailAt) || 0,
        locked: ((s && s.lockedUntil) || 0) > now,
    }));
    rows.sort((a, b) => Number(b.locked) - Number(a.locked) || b.lastFailAt - a.lastFailAt);
    return { locks: rows };
}

async function unlock(body) {
    // 관리자·마스터 계정의 잠금은 `admin:이메일` 형태로 저장된다(학생 아이디와 겹치지 않게).
    const raw = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    const id = /^admin:[a-z0-9._@+-]{3,160}$/.test(raw) ? raw : normalizeLoginId(body.id);
    if (!id) throw fail(400, "bad_id");
    await admin.database().ref(`loginLockouts/${dbKey(id)}`).remove();
    return { ok: true };
}

// ---------- PIN 초기화 ----------
async function resetPin(body) {
    const uid = needUid(body);
    if (!isValidPin(body.pin)) throw fail(400, "bad_pin");
    let user;
    try { user = await admin.auth().getUser(uid); } catch (e) { throw fail(404, "no_user"); }

    const { salt, hash } = hashPin(body.pin);
    const updates = {
        [`loginSecrets/${uid}/salt`]: salt,
        [`loginSecrets/${uid}/hash`]: hash,
        [`loginSecrets/${uid}/migratedAt`]: admin.database.ServerValue.TIMESTAMP,
    };
    const exists = (await admin.database().ref(`students/${uid}`).once("value")).val();
    if (exists) updates[`students/${uid}/phone`] = encryptOne(process.env.AES_KEY, body.pin);
    await admin.database().ref().update(updates);

    // 아직 옛 방식(비밀번호=00+PIN)으로 남은 계정이면 Firebase 비밀번호도 무작위로 바꾼다.
    const secret = (await admin.database().ref(`loginSecrets/${uid}`).once("value")).val() || {};
    if (!secret.randomized) {
        try {
            await admin.auth().updateUser(uid, { password: randomAuthPassword() });
            await admin.database().ref(`loginSecrets/${uid}/randomized`).set(true);
        } catch (e) { /* 다음 로그인 때 다시 시도됨 */ }
    }
    const id = normalizeLoginId(user.email);
    if (id) await admin.database().ref(`loginLockouts/${dbKey(id)}`).remove();
    return { ok: true };
}

// ---------- 학생 목록 / 계정 관리 ----------
async function listStudents() {
    const [studentsSnap, lockSnap] = await Promise.all([
        admin.database().ref("students").once("value"),
        admin.database().ref("loginLockouts").once("value"),
    ]);
    const students = studentsSnap.val() || {};
    const locks = lockSnap.val() || {};

    const authInfo = {};
    let pageToken;
    do {
        const page = await admin.auth().listUsers(1000, pageToken);
        page.users.forEach((u) => {
            authInfo[u.uid] = {
                disabled: Boolean(u.disabled),
                lastSignInTime: u.metadata && u.metadata.lastSignInTime ? Date.parse(u.metadata.lastSignInTime) : 0,
                creationTime: u.metadata && u.metadata.creationTime ? Date.parse(u.metadata.creationTime) : 0,
                email: u.email || "",
            };
        });
        pageToken = page.pageToken;
    } while (pageToken);

    const now = Date.now();
    const rows = Object.entries(students).map(([uid, s]) => {
        s = s || {};
        const info = authInfo[uid] || {};
        const login = normalizeLoginId(info.email || s.u2mId || "") || "";
        const lock = login ? locks[dbKey(login)] : null;
        return {
            uid,
            name: safePlain(s.name),
            u2mId: s.u2mId || "",
            schoolName: s.schoolName || "",
            grade: s.grade || "",
            class: s.class || s.className || "",
            teacher: s.teacher || "",
            joinedAt: s.joinedAt || info.creationTime || 0,
            lastSignInAt: info.lastSignInTime || 0,
            disabled: Boolean(info.disabled),
            locked: Boolean(lock && (lock.lockedUntil || 0) > now),
            hasAuth: Boolean(authInfo[uid]),
        };
    });
    rows.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    return { students: rows, serverNow: now };
}

async function setDisabled(body) {
    const uid = needUid(body);
    const disabled = Boolean(body.disabled);
    await admin.auth().updateUser(uid, { disabled });
    if (disabled && admin.auth().revokeRefreshTokens) await admin.auth().revokeRefreshTokens(uid);
    return { ok: true, disabled };
}

async function deleteStudent(body) {
    const uid = needUid(body);
    await purgeStudentData(uid);
    try { await admin.auth().deleteUser(uid); } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
    return { ok: true };
}

// ---------- 랭킹 이름 동기화 점검 ----------
// 랭킹 화면은 students/{uid}/name 과 public_students/{uid}/name의 암호문이 "완전히 똑같은
// 문자열"일 때만 그 학생 이름을 복호화해서 보여준다(남의 전화번호 등은 안 풀어주려고 서버가
// 직접 대조하는 로직 — api/decrypt.js 참고). 둘이 어긋나 있으면 그 학생 이름만 조용히
// "학생"으로 보인다(공백은 아님, 화면에서 그렇게 대체하도록 바꿔뒀다). 가입(api/register.js)은
// 항상 같은 암호문을 양쪽에 같이 쓰므로 정상적으로는 어긋날 일이 없는데, 혹시 어긋난 계정이
// 있는지 확인하고(check) 있으면 공개용 쪽을 원본(students)에 맞춰 고친다(fix).
async function nameSyncCheck() {
    const [studentsSnap, pubSnap] = await Promise.all([
        admin.database().ref("students").once("value"),
        admin.database().ref("public_students").once("value"),
    ]);
    const students = studentsSnap.val() || {};
    const pub = pubSnap.val() || {};
    const mismatched = [];
    Object.keys(students).forEach((uid) => {
        const privName = students[uid] && students[uid].name;
        const pubEntry = pub[uid];
        if (!privName) return; // 이름 자체가 없는 계정(가입 중단 등)은 대상 아님
        if (!pubEntry) { mismatched.push({ uid, name: safePlain(privName), issue: "public_students_missing" }); return; }
        if (pubEntry.name !== privName) mismatched.push({ uid, name: safePlain(privName), issue: "cipher_mismatch" });
    });
    return { total: Object.keys(students).length, mismatched };
}

async function nameSyncFix() {
    const [studentsSnap, pubSnap] = await Promise.all([
        admin.database().ref("students").once("value"),
        admin.database().ref("public_students").once("value"),
    ]);
    const students = studentsSnap.val() || {};
    const pub = pubSnap.val() || {};
    const updates = {};
    Object.keys(students).forEach((uid) => {
        const privName = students[uid] && students[uid].name;
        if (!privName) return;
        const pubEntry = pub[uid];
        if (!pubEntry || pubEntry.name !== privName) updates[`public_students/${uid}/name`] = privName;
    });
    const fixed = Object.keys(updates).length;
    if (fixed) await admin.database().ref().update(updates);
    return { ok: true, fixed };
}

// ---------- 출석 보정 ----------
async function setAttendance(body) {
    const uid = needUid(body);
    if (!isRealDate(body.date)) throw fail(400, "bad_date");
    const today = kstDateParts().date;
    if (body.date > today) throw fail(400, "future_date");
    const present = Boolean(body.present);
    const ym = body.date.slice(0, 7);

    const ref = admin.database().ref(`attendance/${uid}/${ym}`);
    const result = await ref.transaction((current) => {
        const data = current || {};
        const days = data.days || {};
        if (present) days[body.date] = true; else delete days[body.date];
        if (!Object.keys(days).length) return null;
        return { days, count: Object.keys(days).length, lastAttendance: data.lastAttendance || Date.now() };
    });
    const month = result.snapshot.val();
    const count = month ? month.count || 0 : 0;
    await admin.database().ref(`public_attendance_counts/${uid}/${ym}`).set(count);
    const total = await grantAttendanceBadges(uid);
    return { ok: true, count, total };
}

async function getAttendance(body) {
    const uid = needUid(body);
    const val = (await admin.database().ref(`attendance/${uid}`).once("value")).val() || {};
    const days = [];
    Object.values(val).forEach((m) => Object.keys((m && m.days) || {}).forEach((d) => days.push(d)));
    days.sort();
    return { days };
}

// ---------- 시스템 상태 ----------
async function systemStatus() {
    const has = (name, minLen = 1) => Boolean(process.env[name] && process.env[name].length >= minLen);
    const db = admin.database();
    const [lockSnap, drawSnap, metaSnap, studentSnap, secretSnap] = await Promise.all([
        db.ref("loginLockouts").once("value"),
        db.ref("lottoDraws").orderByKey().limitToLast(1).once("value"),
        db.ref("lottoMeta").once("value"),
        db.ref("students").once("value"),
        db.ref("loginSecrets").once("value"),
    ]);
    const locks = Object.values(lockSnap.val() || {});
    const now = Date.now();
    const draw = drawSnap.val() || {};
    const latestRound = Object.keys(draw).length ? Number(Object.keys(draw)[0]) : null;

    // Firebase 비밀번호가 아직도 "00"+PIN(무작위화 전)인 계정은 우리 서버(IP 한도/계정
    // 락아웃/reCAPTCHA)를 거치지 않고 Firebase 자체 REST API(signInWithPassword)를 공개
    // 웹 키로 직접 두드려 무차별 대입할 수 있다 — randomized:true가 될 때까지의 위험 구간.
    const students = studentSnap.val() || {};
    const secrets = secretSnap.val() || {};
    let migrated = 0, unmigrated = 0;
    Object.keys(students).forEach((uid) => {
        const s = secrets[uid];
        if (s && s.randomized) migrated++; else unmigrated++;
    });

    return {
        env: {
            AES_KEY: has("AES_KEY"), AES_KEY_STRONG: has("AES_KEY", 32), AES_KEY_OLD: has("AES_KEY_OLD"),
            FIREBASE_SERVICE_ACCOUNT: has("FIREBASE_SERVICE_ACCOUNT"), PIN_PEPPER: has("PIN_PEPPER", 32),
            RECAPTCHA_V3_SECRET_KEY: has("RECAPTCHA_V3_SECRET_KEY"), CRON_SECRET: has("CRON_SECRET", 16),
            ALLOWED_ORIGIN: has("ALLOWED_ORIGIN"), NEIS_API_KEY: has("NEIS_API_KEY"), KMA_API_KEY: has("KMA_API_KEY"),
        },
        lotto: {
            storedRound: latestRound,
            expectedRound: lotto.expectedLatestRound(now),
            lastAttemptAt: (metaSnap.val() || {}).lastAttemptAt || 0,
            lastError: (metaSnap.val() || {}).lastError || "",
        },
        logins: {
            students: Object.keys(students).length,
            lockedNow: locks.filter((s) => s && (s.lockedUntil || 0) > now).length,
            failedLast24h: locks.filter((s) => s && s.lastFailAt && now - s.lastFailAt < DAY_MS).length,
            passwordMigrated: migrated,
            passwordNotMigrated: unmigrated,
        },
        serverNow: now,
    };
}

// ---------- 로또 ----------
async function lottoResync() {
    const state = await lotto.syncNow();
    const meta = (await admin.database().ref("lottoMeta").once("value")).val() || {};
    return { ok: true, storedRound: state.latest ? state.latest.round : null, expectedRound: state.expected, lastError: meta.lastError || "" };
}

async function lottoSetDraw(body) {
    const round = Number(body.round);
    const numbers = (Array.isArray(body.numbers) ? body.numbers : []).map(Number);
    const bonus = Number(body.bonus);
    const expected = lotto.expectedLatestRound(Date.now());
    const valid =
        Number.isInteger(round) && round >= 1 && round <= expected &&
        numbers.length === 6 && numbers.every(lotto.isBall) && new Set([...numbers, bonus]).size === 7 && lotto.isBall(bonus);
    if (!valid) throw fail(400, "bad_draw");
    const sorted = numbers.sort((a, b) => a - b);
    await admin.database().ref(`lottoDraws/${round}`).set({ numbers: sorted, bonus, syncedAt: Date.now(), manual: true });
    await lotto.finalizeRound(round, { numbers: sorted, bonus });
    return { ok: true, round };
}

async function lottoClearPredictions(body) {
    const round = Number(body.round);
    if (!Number.isInteger(round) || round < 1) throw fail(400, "bad_round");
    await admin.database().ref(`lotto_predictions/${round}`).remove();
    return { ok: true, round };
}

// 최근 회차별 참여자 수와 적중 개수 분포
async function lottoSummary() {
    const db = admin.database();
    const drawsSnap = await db.ref("lottoDraws").orderByKey().limitToLast(12).once("value");
    const draws = drawsSnap.val() || {};
    const rounds = Object.keys(draws).map(Number).sort((a, b) => b - a);
    const snaps = await Promise.all(rounds.map((r) => db.ref(`lotto_predictions/${r}`).once("value")));
    const rows = rounds.map((round, i) => {
        const preds = Object.values(snaps[i].val() || {}).filter((p) => p && Array.isArray(p.numbers));
        const distribution = [0, 0, 0, 0, 0, 0, 0];
        let bonusHits = 0;
        let pending = 0;
        preds.forEach((p) => {
            if (typeof p.matchedCount === "number" && p.matchedCount >= 0 && p.matchedCount <= 6) distribution[p.matchedCount]++;
            else pending++;
            if (p.bonusHit) bonusHits++;
        });
        return { round, numbers: draws[round].numbers || [], bonus: draws[round].bonus || null, participants: preds.length, distribution, bonusHits, pending };
    });
    return { rounds: rows };
}

// ---------- 태블릿 허용 사이트 ----------
async function tabletSitesGet() {
    const cur = await tabletSites.readSites(admin.database());
    return { ...cur, defaults: tabletSites.DEFAULT_HOSTS, core: tabletSites.CORE_HOST, max: tabletSites.MAX_HOSTS };
}

async function tabletSitesSet(body) {
    if (!Array.isArray(body.hosts)) throw fail(400, "bad_hosts");
    try {
        return await tabletSites.writeSites(admin.database(), body.hosts, body.__uid);
    } catch (e) {
        if (e.rejected) { const err = fail(400, "bad_hosts"); err.rejected = e.rejected; throw err; }
        throw e;
    }
}

// ---------- 옛 학생 계정 보호 ----------
// Firebase 비밀번호가 아직 "00"+PIN 그대로인 계정은 Firebase 로그인 주소를 직접 두드리는 대입에 노출돼 있다.
// 이 버튼은 그런 계정을 서버 PIN 검증 방식으로 이전한다(한 번에 PER_CALL명씩, 화면이 남은 수가 0이 될 때까지 반복 호출).
const MIGRATE_PER_CALL = 8;

async function legacyAuthStatus() {
    const { total, done, pending } = await authMigration.listPending();
    return { total, protected: done, pending: pending.length };
}

async function legacyAuthMigrate(body) {
    // 이전이 안 되는 계정(저장된 PIN과 실제 비밀번호가 다름 등)이 앞에 몰려 있어도 뒤 계정이 막히지 않게,
    // 화면이 이미 시도한 uid(skip)를 보내면 그것들은 건너뛴다.
    const skip = new Set((Array.isArray(body.skip) ? body.skip : []).filter((x) => typeof x === "string").slice(0, 1000));
    const { pending } = await authMigration.listPending();
    const batch = pending.filter((p) => !skip.has(p.uid)).slice(0, MIGRATE_PER_CALL);
    const out = { migrated: 0, mismatch: [], noPin: [], throttled: 0, errors: [], tried: batch.map((p) => p.uid) };
    for (const p of batch) {
        const r = await authMigration.migrateOne({ uid: p.uid, student: p.student, apply: true });
        if (r.status === "migrated") out.migrated++;
        else if (r.status === "mismatch") out.mismatch.push(p.label);
        else if (r.status === "no_pin") out.noPin.push(p.label);
        else if (r.status === "throttled") out.throttled++;
        else out.errors.push(`${p.label}: ${r.message || "error"}`);
        await new Promise((resolve) => setTimeout(resolve, 250)); // Firebase 자체 제한을 건드리지 않도록 천천히
    }
    out.remaining = pending.filter((p) => !skip.has(p.uid)).length - batch.length; // 아직 시도 안 한 계정 수
    out.done = out.remaining <= 0;
    return out;
}

// ---------- 관리자·마스터 비밀번호 ----------
// 이제 서버가 비밀번호를 검증하므로 Firebase의 "비밀번호 최대 6자" 정책과 무관하게 긴 비밀번호를 쓸 수 있다.
// 시도 횟수는 잠금으로 제한되지만 약한 비밀번호는 결국 추측되므로, 12자 이상(영문+숫자 포함)만 받는다.
async function adminAccounts() {
    const accounts = [];
    for (const uid of ADMIN_UIDS) {
        try {
            const user = await admin.auth().getUser(uid);
            const secret = (await admin.database().ref(`loginSecrets/${uid}`).once("value")).val();
            accounts.push({ uid, email: user.email || "", serverPassword: Boolean(secret && secret.hash), randomized: Boolean(secret && secret.randomized), changedAt: (secret && secret.changedAt) || 0, isMaster: MASTER_UIDS.has(uid) });
        } catch (e) { /* 계정이 없으면 목록에서 뺀다 */ }
    }
    return { accounts };
}

async function adminPasswordSet(body) {
    if (typeof body.uid !== "string" || !ADMIN_UIDS.has(body.uid)) throw fail(400, "bad_uid");
    const pw = body.password;
    if (typeof pw !== "string" || pw.length < 12 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw fail(400, "weak_password");
    const user = await admin.auth().getUser(body.uid);
    const ref = admin.database().ref(`loginSecrets/${body.uid}`);
    await ref.set({ ...hashSecret(pw), randomized: false, changedAt: admin.database.ServerValue.TIMESTAMP, changedBy: body.__uid || null });
    // Firebase 쪽 비밀번호는 무작위 값으로 바꿔 둔다(주소를 직접 두드려도 대입할 수 없게).
    await admin.auth().updateUser(body.uid, { password: randomAuthPassword() });
    await ref.child("randomized").set(true);
    if (user.email) await admin.database().ref(`loginLockouts/${dbKey(`admin:${user.email.toLowerCase()}`)}`).remove(); // 비밀번호를 바꾸면 잠금도 풀어 준다
    return { ok: true };
}

const ACTIONS = {
    "admin-accounts": adminAccounts,
    "admin-password-set": adminPasswordSet,
    "legacy-auth-status": legacyAuthStatus,
    "legacy-auth-migrate": legacyAuthMigrate,
    "tablet-sites-get": tabletSitesGet,
    "tablet-sites-set": tabletSitesSet,
    locks: listLocks,
    unlock,
    "reset-pin": resetPin,
    students: listStudents,
    "set-disabled": setDisabled,
    "delete-student": deleteStudent,
    "attendance-get": getAttendance,
    "attendance-set": setAttendance,
    status: systemStatus,
    "lotto-resync": lottoResync,
    "lotto-set-draw": lottoSetDraw,
    "lotto-clear-predictions": lottoClearPredictions,
    "lotto-summary": lottoSummary,
    "name-sync-check": nameSyncCheck,
    "name-sync-fix": nameSyncFix,
};

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
        const decoded = await requireAuth(req);
        if (!MASTER_UIDS.has(decoded.uid)) return res.status(403).json({ error: "forbidden" });
        const body = req.body || {};
        const fn = Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
        if (!fn) return res.status(400).json({ error: "bad_action" });
        body.__uid = decoded.uid;
        return res.status(200).json(await fn(body));
    } catch (err) {
        const status = err.statusCode || 500;
        if (status === 500) console.error("admin api error:", err);
        const out = { error: status === 500 ? "server_error" : err.message };
        if (err.rejected) out.rejected = err.rejected; // 허용 사이트 저장 시 쓸 수 없는 항목 목록
        return res.status(status).json(out);
    }
};
