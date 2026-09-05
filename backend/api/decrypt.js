const { applyCors } = require("../lib/cors");
const { requireAuth } = require("../lib/firebaseAdmin");
const { decryptOne, assertValidBatch } = require("../lib/aes");

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        await requireAuth(req);

        const { texts } = req.body || {};
        assertValidBatch(texts);

        const results = texts.map((t) => decryptOne(process.env.AES_KEY, t));
        return res.status(200).json({ results });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: err.message || "Internal error" });
    }
};
