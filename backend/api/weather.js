const { applyCors } = require("../lib/cors");

// 학원 위치(경기도 수원시 영통구) 기준 기상청 단기예보구역코드.
// https://apihub.kma.go.kr/api/typ01/url/fct_shrt_reg.php?tmfc=0&authKey=... 조회 결과 "수원" 매칭.
const REG_ID = "11B20601";

// 기상청 단기예보(육상) API. VilageFcstInfoService_2.0(오픈API)는 authKey 발급과
// 별개로 API Hub에서 "활용신청" 승인을 받아야 하는데, 이 typ01/url 계열 API는
// authKey만으로 바로 호출 가능해서 이걸 쓴다. disp=1(콤마 구분)로 파싱을 단순화하고,
// help=0으로 안내 주석 줄을 뺀다. tmfc1/tmfc2를 비우면 가장 최근 발표자료를 준다.
async function fetchLandForecast() {
    const params = new URLSearchParams({
        reg: REG_ID,
        tmfc1: "",
        tmfc2: "",
        disp: "1",
        help: "0",
        authKey: process.env.KMA_API_KEY,
    });
    const url = `https://apihub.kma.go.kr/api/typ01/url/fct_afs_dl.php?${params.toString()}`;
    const kmaRes = await fetch(url);
    const rawBody = await kmaRes.text();

    const lines = rawBody.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
    if (lines.length === 0) {
        return { ok: false, error: "예보 데이터가 비어 있습니다", bodyPreview: rawBody.slice(0, 500) };
    }

    // REG_ID,TM_FC,TM_EF,MOD,NE,STN,C,MAN_ID,MAN_FC,W1,T,W2,TA,ST,SKY,PREP,WF (17개 필드)
    const rows = lines.map(line => line.split(",").map(f => f.trim()));
    if (rows.some(r => r.length < 17)) {
        return { ok: false, error: "예보 응답 형식이 예상과 다릅니다", bodyPreview: rawBody.slice(0, 500) };
    }

    return {
        ok: true,
        rows: rows.map(r => ({
            regId: r[0], tmEf: r[2], w1: r[9], w2: r[11],
            ta: r[12], st: r[13], sky: r[14], prep: r[15], wf: r[16].replace(/^"|"$/g, ""),
        })),
    };
}

// 여러 구간(NE 0,1,2,3 = 짧은 순서대로) 중 지금 이후로 가장 가까운 발효시각의
// 구간을 고른다. TM_EF는 yyyyMMddHHmm(KST) 형식.
function pickNearestRow(rows) {
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
    const nowKst = new Date(Date.now() + KST_OFFSET_MS);
    const y = nowKst.getUTCFullYear();
    const m = String(nowKst.getUTCMonth() + 1).padStart(2, "0");
    const d = String(nowKst.getUTCDate()).padStart(2, "0");
    const h = String(nowKst.getUTCHours()).padStart(2, "0");
    const nowKey = `${y}${m}${d}${h}00`;

    const sorted = [...rows].sort((a, b) => a.tmEf.localeCompare(b.tmEf));
    return sorted.find(r => r.tmEf >= nowKey) || sorted[sorted.length - 1] || null;
}

// SKY(하늘상태)/PREP(강수유무) 코드를 프론트엔드가 기대하는 OpenWeatherMap 스타일
// id 범위로 변환한다(200번대 뇌우, 300~599 비, 600번대 눈, 800 맑음, 800 초과 흐림).
function toWeatherId(sky, prep) {
    if (prep === "1") return 500; // 비
    if (prep === "4") return 521; // 소나기
    if (prep === "2" || prep === "3") return 600; // 눈, 비/눈
    if (sky === "DB04") return 804; // 흐림
    if (sky === "DB03") return 801; // 구름많음
    if (sky === "DB02") return 802; // 구름조금
    return 800; // 맑음
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
        const result = await fetchLandForecast();
        if (!result.ok) {
            return res.status(502).json({ error: result.error, bodyPreview: result.bodyPreview });
        }

        const row = pickNearestRow(result.rows);
        if (!row) {
            return res.status(502).json({ error: "예보 데이터에서 필요한 값을 찾지 못했습니다" });
        }

        const temp = parseFloat(row.ta);
        const precipProb = parseInt(row.st, 10);

        return res.status(200).json({
            main: {
                temp: isNaN(temp) ? null : temp,
                precipProb: isNaN(precipProb) ? null : precipProb,
            },
            weather: [{ id: toWeatherId(row.sky, row.prep), description: row.wf || "" }],
            wind: { dir: row.w2 || row.w1 || "-" },
        });
    } catch (err) {
        return res.status(502).json({ error: "Failed to reach KMA API", detail: err.message });
    }
};
