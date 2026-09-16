const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { decryptOne, assertValidBatch } = require("../lib/aes");

// 관리자 계정만 아무 학생의 암호문이나 복호화할 수 있다. 그 외에는 본인 데이터거나,
// 실제로 그 학생의 "이름"과 일치하는 값일 때만 복호화를 허용한다(랭킹 화면에서
// 다른 학생 이름은 봐야 하지만, 그 학생의 연락처/매쓰플랫 비밀번호까지 보여줄 필요는 없음).
const ADMIN_UIDS = new Set([
    "53GNQdLdQ0aH2QzOzjdb0WQIwJH3",
    "9temrm7WfSXRKo5v5jJiz65t8yF2",
]);

// ownerUid가 호출자 본인이 아닐 때, 그 값이 정말 "이름" 필드인지 실제 DB를 조회해
// 확인한다. 클라이언트가 보낸 값을 그대로 믿으면 phone/mathflatPw 같은 다른 필드를
// "이름"이라고 속여서 복호화시킬 수 있기 때문에, 서버가 직접 대조한다.
async function isVerifiedOtherStudentName(ownerUid, cipherText) {
    if (!ownerUid || !cipherText) return false;
    try {
        const snap = await admin.database().ref(`students/${ownerUid}/name`).get();
        const actual = snap.val();
        return typeof actual === "string" && actual === cipherText;
    } catch (e) {
        return false;
    }
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const decoded = await requireAuth(req);
        const isAdmin = ADMIN_UIDS.has(decoded.uid);

        const { items } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            const err = new Error("`items` must be a non-empty array");
            err.statusCode = 400;
            throw err;
        }
        assertValidBatch(items.map((it) => (it && it.text) || ""));

        const results = await Promise.all(
            items.map(async (item) => {
                const text = (item && item.text) || "";
                const ownerUid = item && item.ownerUid;
                if (!text) return "";

                const allowed =
                    isAdmin ||
                    ownerUid === decoded.uid ||
                    (await isVerifiedOtherStudentName(ownerUid, text));

                if (!allowed) return "";
                return decryptOne(process.env.AES_KEY, text);
            })
        );

        return res.status(200).json({ results });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: err.message || "Internal error" });
    }
};
