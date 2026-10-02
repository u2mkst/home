const { applyCors } = require("../lib/cors");
const { admin } = require("../lib/firebaseAdmin");
const { encryptOne } = require("../lib/aes");
const { hashPin, isValidPin } = require("../lib/pin");
const { randomAuthPassword } = require("../lib/authPassword");
const { toLoginEmail, isBotSuspected, consumeIpQuota } = require("../lib/guard");

// 🔒 학생 회원가입. 예전엔 클라이언트가 createUserWithEmailAndPassword(아이디, "00"+PIN)로 계정을
// 만들어서 가입 직후 계정이 4자리 비밀번호를 갖고 있었고, 가입 API(Firebase REST)가 공개돼 있어
// 아무나 계정을 무한 생성할 수도 있었다. 이제 계정 생성·암호화·DB 기록을 전부 서버가 하고,
// Firebase 비밀번호는 무작위 값, PIN은 해시로만 보관한다.
const IP_REGISTER_LIMIT = 60;               // IP당 시간당 가입 시도(같은 와이파이에서 여러 명이 가입해도 넉넉하게)
const IP_WINDOW_MS = 60 * 60 * 1000;

// login.html 가입 화면의 선택지와 같은 목록이어야 한다.
const TEACHERS = new Set(["김동진", "이주희", "차현준", "권준수", "박다희", "정찬호", "김영호"]);
const GRADES = new Set(["초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3"]);

function academicYearKst() {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const month = kst.getUTCMonth() + 1;
    return month >= 3 ? kst.getUTCFullYear() : kst.getUTCFullYear() - 1;
}

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function cleanText(value, maxLen) {
    const text = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return text.length <= maxLen ? text : null;
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    let createdUid = null;
    try {
        const b = req.body || {};

        const quota = await consumeIpQuota(req, "register", IP_REGISTER_LIMIT, IP_WINDOW_MS);
        if (!quota.allowed) {
            return res.status(429).json({ error: "ip_limited", retryAfterMs: quota.retryAfterMs });
        }
        if (await isBotSuspected(b.recaptchaToken, "register")) {
            return res.status(403).json({ error: "bot" });
        }

        const id = String(b.id || "").trim().toLowerCase();
        if (!/^ufes\d{1,12}$/.test(id)) throw badRequest("유투엠 아이디 형식이 올바르지 않습니다.");
        if (!isValidPin(b.pin)) throw badRequest("전화번호 뒷자리는 숫자 4자리여야 합니다.");

        const name = cleanText(b.name, 30);
        const schoolName = cleanText(b.schoolName, 60);
        const schoolCode = cleanText(b.schoolCode, 12);
        const schoolClassNum = cleanText(b.schoolClassNum, 2);
        const mathflatPw = cleanText(b.mathflatPw, 64);
        const mathflatPhone = String(b.mathflatPhone || "").replace(/[^0-9]/g, "");

        if (!name) throw badRequest("이름을 입력해 주세요.");
        if (!schoolName || !schoolCode || !/^[0-9A-Za-z]{3,12}$/.test(schoolCode)) throw badRequest("학교 정보를 확인해 주세요.");
        if (!GRADES.has(b.grade)) throw badRequest("학년을 선택해 주세요.");
        if (schoolClassNum === null || !/^\d{0,2}$/.test(schoolClassNum)) throw badRequest("반 정보가 올바르지 않습니다.");
        if (!TEACHERS.has(b.teacher)) throw badRequest("담당 선생님을 선택해 주세요.");
        if (mathflatPhone.length > 11 || mathflatPw === null) throw badRequest("매쓰플랫 정보가 올바르지 않습니다.");

        const email = toLoginEmail(id);
        try {
            await admin.auth().getUserByEmail(email);
            return res.status(409).json({ error: "exists" });
        } catch (e) {
            if (e.code !== "auth/user-not-found") throw e;
        }

        const user = await admin.auth().createUser({
            email,
            password: randomAuthPassword(),
            displayName: name,
        });
        createdUid = user.uid;

        const key = process.env.AES_KEY;
        const classLabel = schoolClassNum ? `${schoolClassNum}반` : "";
        const ts = admin.database.ServerValue.TIMESTAMP;
        const encName = encryptOne(key, name);

        await admin.database().ref().update({
            [`students/${user.uid}`]: {
                name: encName,
                u2mId: id,
                schoolName,
                schoolCode,
                grade: b.grade,
                schoolClassNum,
                class: classLabel,
                className: classLabel,
                gradePromotionYear: academicYearKst(),
                teacher: b.teacher,
                phone: encryptOne(key, b.pin),
                studentPhone: mathflatPhone ? encryptOne(key, mathflatPhone) : "",
                mathflatPw: mathflatPw ? encryptOne(key, mathflatPw) : "",
                mathflatId: mathflatPhone,
                joinedAt: ts,
            },
            [`public_students/${user.uid}`]: { name: encName, schoolName, teacher: b.teacher },
            [`loginSecrets/${user.uid}`]: { ...hashPin(b.pin), randomized: true, migratedAt: ts },
        });

        return res.status(200).json({ ok: true });
    } catch (err) {
        if (createdUid) {
            // DB 기록에 실패하면 반쯤 만들어진 계정이 남지 않도록 되돌린다.
            await admin.auth().deleteUser(createdUid).catch(() => {});
        }
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};
