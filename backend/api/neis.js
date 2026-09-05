const { applyCors } = require("../lib/cors");

const ALLOWED_ENDPOINTS = new Set([
    "schoolInfo",
    "SchoolSchedule",
    "elsTimetable",
    "misTimetable",
    "hisTimetable",
]);

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { endpoint, ...params } = req.query || {};

    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
        return res.status(400).json({ error: "Unknown or missing `endpoint`" });
    }

    if (!process.env.NEIS_API_KEY) {
        return res.status(500).json({ error: "NEIS_API_KEY is not configured on the server" });
    }

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined) continue;
        search.set(key, Array.isArray(value) ? value[0] : value);
    }
    search.set("KEY", process.env.NEIS_API_KEY);
    search.set("Type", "json");

    const url = `https://open.neis.go.kr/hub/${endpoint}?${search.toString()}`;

    let neisRes;
    try {
        neisRes = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (KST backend proxy)" },
        });
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach NEIS API", detail: err.message });
    }

    const rawBody = await neisRes.text();
    try {
        return res.status(neisRes.status).json(JSON.parse(rawBody));
    } catch (err) {
        return res.status(502).json({
            error: "NEIS API returned a non-JSON response",
            neisStatus: neisRes.status,
            bodyPreview: rawBody.slice(0, 300),
        });
    }
};
