const { applyCors } = require("../lib/cors");

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { school, grade, class_num, region } = req.query || {};

    if (!school || !grade || !class_num) {
        return res.status(400).json({ error: "`school`, `grade` and `class_num` are required" });
    }

    const search = new URLSearchParams({ grade, class_num });
    if (region) search.set("region", region);

    const url = `https://sch-5bnq.onrender.com/timetable/${encodeURIComponent(school)}?${search.toString()}`;

    let upstreamRes;
    try {
        upstreamRes = await fetch(url);
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach comcigan API", detail: err.message });
    }

    const rawBody = await upstreamRes.text();
    try {
        return res.status(upstreamRes.status).json(JSON.parse(rawBody));
    } catch (err) {
        return res.status(502).json({
            error: "comcigan API returned a non-JSON response",
            upstreamStatus: upstreamRes.status,
            bodyPreview: rawBody.slice(0, 300),
        });
    }
};
