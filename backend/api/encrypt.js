const { applyCors } = require("../lib/cors");
const { requireAuth } = require("../lib/firebaseAdmin");
const { encryptOne, assertValidBatch } = require("../lib/aes");
const { rejectIfUserRateLimited } = require("../lib/guard");

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const decoded = await requireAuth(req);
        // 계정당 분당 60회(메시지·문의·프로필 저장 등 정상 사용량의 수십 배)
        if (await rejectIfUserRateLimited(res, decoded.uid, "encrypt", 60, 60 * 1000)) return;

        const { texts } = req.body || {};
        assertValidBatch(texts);

        const results = texts.map((t) => encryptOne(process.env.AES_KEY, t));
        return res.status(200).json({ results });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: err.message || "Internal error" });
    }
};
