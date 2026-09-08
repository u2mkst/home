const { applyCors } = require("../lib/cors");

async function fetchTimetable(school, search) {
    const url = `https://sch-5bnq.onrender.com/timetable/${encodeURIComponent(school)}?${search.toString()}`;
    const upstreamRes = await fetch(url);
    const rawBody = await upstreamRes.text();
    let json;
    try {
        json = JSON.parse(rawBody);
    } catch (err) {
        return { ok: false, status: 502, body: { error: "comcigan API returned a non-JSON response", upstreamStatus: upstreamRes.status, bodyPreview: rawBody.slice(0, 300) } };
    }
    const ok = upstreamRes.ok && !json.detail && json.timetable;
    return { ok, status: upstreamRes.status, body: json };
}

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

    // 컴시간 학교 DB는 정식 명칭 대신 "학교"를 뗀 축약형으로 등록된 경우가 있다
    // (예: NEIS "광교호수중학교" ↔ 컴시간 "광교호수중"). 원래 이름으로 먼저 시도하고
    // 실패하면 "학교" 접미사를 뗀 이름으로 한 번 더 시도한다.
    const nameVariants = [school];
    if (/학교$/.test(school)) nameVariants.push(school.replace(/학교$/, ""));

    let result;
    try {
        for (const name of nameVariants) {
            result = await fetchTimetable(name, search);
            if (result.ok) break;
        }
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach comcigan API", detail: err.message });
    }

    return res.status(result.status).json(result.body);
};
