const { applyCors } = require("../lib/cors");

// 학원 고정 위치(경기도 수원시 영통구 혜령로 8 — 광교/이의동 인근) 기준 기상청
// 단기예보 격자 좌표. 기상청 공식 위경도<->격자 변환식으로 계산한 값이라
// 실제 위치와 몇백 m 오차가 있어도 5km 격자 특성상 결과는 동일하다.
const NX = 61;
const NY = 121;

const BASE_HOURS = [23, 20, 17, 14, 11, 8, 5, 2];

// 단기예보 발표시각(02,05,08,11,14,17,20,23시) 중 "지금 기준으로 이미 발표되고
// API에 반영됐을" 가장 최근 시각을 구한다. 서버는 UTC로 돌 수 있으므로 KST로
// 보정하고, 발표 직후 반영 지연을 감안해 10분 여유를 둔다.
function getBaseDateTime(offsetSlots = 0) {
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const nowKst = new Date(Date.now() + KST_OFFSET_MS - 10 * 60 * 1000);
    const hour = nowKst.getUTCHours();

    let idx = BASE_HOURS.findIndex(t => hour >= t);
    if (idx === -1) idx = BASE_HOURS.length - 1; // 자정~새벽 2시 전: 전날 23시 발표
    // BASE_HOURS가 내림차순이라 idx가 커질수록 더 이른 시각이 된다.
    // offsetSlots=-1(한 슬롯 이전)을 요청하면 idx를 +1 해야 한다.
    idx -= offsetSlots;

    let dayOffset = 0;
    while (idx >= BASE_HOURS.length) { idx -= BASE_HOURS.length; dayOffset += 1; }
    while (idx < 0) { idx += BASE_HOURS.length; dayOffset -= 1; }

    const baseDate = new Date(nowKst.getTime() - dayOffset * 24 * 60 * 60 * 1000);
    const y = baseDate.getUTCFullYear();
    const m = String(baseDate.getUTCMonth() + 1).padStart(2, "0");
    const d = String(baseDate.getUTCDate()).padStart(2, "0");

    return {
        base_date: `${y}${m}${d}`,
        base_time: String(BASE_HOURS[idx]).padStart(2, "0") + "00",
    };
}

async function fetchVilageFcst(base_date, base_time) {
    const params = new URLSearchParams({
        pageNo: "1",
        numOfRows: "1000",
        dataType: "JSON",
        base_date,
        base_time,
        nx: String(NX),
        ny: String(NY),
        authKey: process.env.KMA_API_KEY,
    });
    const url = `https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0/getVilageFcst?${params.toString()}`;
    const kmaRes = await fetch(url);
    const rawBody = await kmaRes.text();
    let json;
    try {
        json = JSON.parse(rawBody);
    } catch (e) {
        return { ok: false, error: "KMA 응답이 JSON이 아닙니다", bodyPreview: rawBody.slice(0, 300) };
    }
    const header = json && json.response && json.response.header;
    if (!header || header.resultCode !== "00") {
        return { ok: false, error: (header && header.resultMsg) || "KMA API 오류" };
    }
    const items = (json.response.body && json.response.body.items && json.response.body.items.item) || [];
    return { ok: true, items };
}

// 항목들을 fcstDate+fcstTime 단위로 묶어서, 지금 이후 가장 가까운 시간대의
// TMP/SKY/PTY/REH/WSD 값을 뽑아낸다.
function pickNearestSlot(items) {
    const grouped = {};
    for (const it of items) {
        const key = it.fcstDate + it.fcstTime;
        if (!grouped[key]) grouped[key] = {};
        grouped[key][it.category] = it.fcstValue;
    }
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const nowKst = new Date(Date.now() + KST_OFFSET_MS);
    const y = nowKst.getUTCFullYear();
    const m = String(nowKst.getUTCMonth() + 1).padStart(2, "0");
    const d = String(nowKst.getUTCDate()).padStart(2, "0");
    const h = String(nowKst.getUTCHours()).padStart(2, "0");
    const nowKey = `${y}${m}${d}${h}00`;

    const keys = Object.keys(grouped).sort();
    const chosenKey = keys.find(k => k >= nowKey) || keys[keys.length - 1];
    return chosenKey ? grouped[chosenKey] : null;
}

// 프론트엔드(index.html/lite.html)가 이미 OpenWeatherMap 응답 구조를 그대로
// 쓰고 있어서, 기상청 코드를 그 구조에 맞게 변환해준다 — 화면 렌더링 코드는
// 하나도 안 건드리고 API 공급자만 바꿀 수 있게.
function toWeatherShape(slot) {
    const temp = parseFloat(slot.TMP);
    const humidity = parseInt(slot.REH, 10);
    const windSpeed = parseFloat(slot.WSD);
    const pty = slot.PTY;
    const sky = slot.SKY;

    let id = 800;
    let description = "맑음";
    if (pty === "1" || pty === "5") { id = 500; description = "비"; }
    else if (pty === "4") { id = 521; description = "소나기"; }
    else if (pty === "3" || pty === "7") { id = 600; description = "눈"; }
    else if (pty === "2" || pty === "6") { id = 611; description = "진눈깨비"; }
    else if (sky === "3") { id = 801; description = "구름많음"; }
    else if (sky === "4") { id = 804; description = "흐림"; }

    return {
        main: { temp: isNaN(temp) ? null : temp, humidity: isNaN(humidity) ? null : humidity },
        weather: [{ id, description }],
        wind: { speed: isNaN(windSpeed) ? 0 : windSpeed },
    };
}

module.exports = async (req, res) => {
    if (applyCors(req, res)) return;

    if (req.method !== "GET") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    if (!process.env.KMA_API_KEY) {
        return res.status(500).json({ error: "KMA_API_KEY is not configured on the server" });
    }

    try {
        let { base_date, base_time } = getBaseDateTime();
        let result = await fetchVilageFcst(base_date, base_time);

        // 발표 직후라 기상청 쪽에 아직 반영 안 됐을 수 있으니, 비어있으면 한 번
        // 이전 발표 시각으로 재시도한다.
        if (result.ok && result.items.length === 0) {
            ({ base_date, base_time } = getBaseDateTime(-1));
            result = await fetchVilageFcst(base_date, base_time);
        }

        if (!result.ok) {
            return res.status(502).json({ error: result.error, bodyPreview: result.bodyPreview });
        }

        const slot = pickNearestSlot(result.items);
        if (!slot || slot.TMP === undefined) {
            return res.status(502).json({ error: "예보 데이터에서 필요한 값을 찾지 못했습니다" });
        }

        return res.status(200).json(toWeatherShape(slot));
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach KMA API", detail: err.message });
    }
};
