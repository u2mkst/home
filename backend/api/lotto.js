const { applyCors } = require("../lib/cors");
const { admin, requireAuth } = require("../lib/firebaseAdmin");
const { lottoBadgeUpdates, lottoBonusBadgeUpdates, grantLottoParticipationBadges } = require("../lib/achievements");

// 🔒 로또 예측 이벤트를 서버가 관리한다. 예전엔 클라이언트가 외부 API에서 당첨번호를 직접
// 받아오고(그 응답을 학생이 조작 가능), 예측을 직접 DB에 써서 — 발표 후에 번호를 제출하거나
// matchedCount를 마음대로 써넣어 적중왕/업적을 가로챌 수 있었다. 이제:
//   1) 추첨이 끝난 직후 서버가 당첨번호를 받아 lottoDraws/{회차}에 저장하고(검증 포함),
//   2) 예측 제출은 서버가 접수 마감 시각(추첨 10분 전)까지만 받고,
//   3) 새 회차가 저장되면 서버가 그 회차 예측을 판정(matchedCount/bonusHit)하고 로또 업적을 지급한다.
// 학생은 lotto_predictions / lottoDraws에 직접 쓸 수 없다(Firebase 규칙).
const DRAW_API = "https://lotto-vzqu.onrender.com/";
const FALLBACK_API = "https://smok95.github.io/lotto/results/latest.json";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ROUND1_DRAW_MS = Date.UTC(2002, 11, 7, 20, 35) - 9 * 60 * 60 * 1000; // 1회차: 2002-12-07 20:35 KST
const SYNC_BUFFER_MS = 15 * 60 * 1000;            // 추첨 방송 후 외부 API에 반영될 때까지의 여유
const SUBMIT_CLOSE_BEFORE_DRAW_MS = 10 * 60 * 1000;
const ATTEMPT_THROTTLE_MS = 20 * 1000;            // 외부 API 호출 최소 간격
const LOCK_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 22 * 1000;
const FALLBACK_TIMEOUT_MS = 10 * 1000;

const db = () => admin.database();

function drawMs(round) {
    return ROUND1_DRAW_MS + (round - 1) * WEEK_MS;
}

// 지금 시각 기준으로 "추첨이 끝나 결과가 나왔어야 하는" 가장 최근 회차
function expectedLatestRound(now) {
    if (now < ROUND1_DRAW_MS + SYNC_BUFFER_MS) return 0;
    return Math.floor((now - ROUND1_DRAW_MS - SYNC_BUFFER_MS) / WEEK_MS) + 1;
}

function isBall(n) {
    return Number.isInteger(n) && n >= 1 && n <= 45;
}

async function getLatestStored() {
    const snap = await db().ref("lottoDraws").orderByKey().limitToLast(1).once("value");
    const val = snap.val();
    if (!val) return null;
    const round = Number(Object.keys(val)[0]);
    return { round, numbers: val[round].numbers, bonus: val[round].bonus };
}

function parseDraw(d) {
    if (!d || typeof d !== "object") return null;
    const round = Number(d.round || d.drwNo || d.draw_no);
    const rawNumbers = Array.isArray(d.numbers) ? d.numbers : [d.drwtNo1, d.drwtNo2, d.drwtNo3, d.drwtNo4, d.drwtNo5, d.drwtNo6];
    const numbers = rawNumbers.map(Number);
    const bonus = Number(d.bonusNo !== undefined ? d.bonusNo : d.bonus_no !== undefined ? d.bonus_no : d.bnusNo);
    const valid =
        Number.isInteger(round) && round >= 1 &&
        numbers.length === 6 && numbers.every(isBall) && new Set(numbers).size === 6 &&
        isBall(bonus) && !numbers.includes(bonus);
    return valid ? { round, numbers: numbers.sort((a, b) => a - b), bonus } : null;
}

async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// 1순위 API가 느리거나(무료 서버 콜드스타트) 아직 새 회차를 못 받았으면 2순위(GitHub Pages 미러)로 넘어간다.
// 어느 쪽이든 형식 검증을 통과한 값만 쓰고, 실패 이유는 lottoMeta/lastError에 남겨 마스터 화면에서 볼 수 있게 한다.
async function fetchLatestDraw(minRound) {
    const errors = [];
    try {
        const json = await fetchJson(DRAW_API, FETCH_TIMEOUT_MS);
        if (!json || json.status !== "success" || !json.data) throw new Error("응답 형식 다름");
        const draw = parseDraw(json.data);
        if (!draw) throw new Error("값 검증 실패");
        if (draw.round >= minRound) return { draw, errors };
        errors.push(`1순위 API가 아직 ${draw.round}회까지만 제공`);
    } catch (e) {
        errors.push(`1순위 API 실패: ${e.name === "AbortError" ? "시간 초과" : e.message}`);
    }
    try {
        const json = await fetchJson(FALLBACK_API, FALLBACK_TIMEOUT_MS);
        const draw = parseDraw(json);
        if (!draw) throw new Error("값 검증 실패");
        if (draw.round >= minRound) return { draw, errors };
        errors.push(`2순위 API가 아직 ${draw.round}회까지만 제공`);
    } catch (e) {
        errors.push(`2순위 API 실패: ${e.name === "AbortError" ? "시간 초과" : e.message}`);
    }
    return { draw: null, errors };
}

// 발표된 회차의 예측을 판정하고 로또 업적을 지급한다(여러 번 실행돼도 결과가 같다).
async function finalizeRound(round, draw) {
    const snap = await db().ref(`lotto_predictions/${round}`).once("value");
    const predictions = snap.val() || {};
    const uids = Object.keys(predictions).filter((uid) => predictions[uid] && Array.isArray(predictions[uid].numbers));
    const achSnaps = await Promise.all(uids.map((uid) => db().ref(`studentAchievements/${uid}`).once("value")));
    const winSet = new Set(draw.numbers);

    const updates = {};
    uids.forEach((uid, i) => {
        const p = predictions[uid];
        const matched = p.numbers.filter((n) => winSet.has(n)).length;
        updates[`lotto_predictions/${round}/${uid}/matchedCount`] = matched;
        const bonusHit = p.bonus === draw.bonus;
        updates[`lotto_predictions/${round}/${uid}/bonusHit`] = bonusHit;
        Object.assign(updates, lottoBadgeUpdates(uid, achSnaps[i].val(), matched));
        Object.assign(updates, lottoBonusBadgeUpdates(uid, achSnaps[i].val(), bonusHit));
    });
    updates[`lottoDraws/${round}/finalizedAt`] = Date.now();
    await db().ref().update(updates);
}

// 추첨이 끝났는데 아직 저장되지 않았다면 외부 API에서 받아 저장한다. 동시에 여러 요청이 와도
// 한 번만 가져오도록 잠금 + 최소 호출 간격을 둔다.
async function ensureSynced() {
    const now = Date.now();
    const expected = expectedLatestRound(now);
    let latest = await getLatestStored();
    if (!expected || (latest && latest.round >= expected)) return { latest, expected };

    const lock = await db().ref("lottoMeta").transaction((cur) => {
        const meta = cur || {};
        if ((meta.lockUntil || 0) > now) return; // 다른 요청이 가져오는 중
        if (meta.lastAttemptAt && now - meta.lastAttemptAt < ATTEMPT_THROTTLE_MS) return;
        return { ...meta, lockUntil: now + LOCK_MS, lastAttemptAt: now };
    });
    if (!lock.committed) return { latest, expected };

    try {
        const { draw, errors } = await fetchLatestDraw(expected);
        // 아직 오지 않은 회차거나(조작/오류) 이미 저장된 회차보다 오래된 값은 버린다.
        if (draw && draw.round <= expected && (!latest || draw.round > latest.round)) {
            await db().ref(`lottoDraws/${draw.round}`).set({ numbers: draw.numbers, bonus: draw.bonus, syncedAt: now });
            await finalizeRound(draw.round, draw);
            latest = { round: draw.round, numbers: draw.numbers, bonus: draw.bonus };
            await db().ref("lottoMeta/lastError").remove().catch(() => {});
        } else {
            const why = draw ? `받은 회차(${draw.round})가 기대 회차(${expected})와 맞지 않음` : errors.join(" / ");
            await db().ref("lottoMeta/lastError").set(`${new Date(now).toISOString()} ${why}`.slice(0, 500)).catch(() => {});
        }
    } finally {
        await db().ref("lottoMeta/lockUntil").set(0).catch(() => {});
    }
    return { latest, expected };
}

function buildStatus({ latest, expected }, now) {
    if (!latest) {
        return { drawnRound: null, numbers: null, bonus: null, targetRound: null, canSubmit: false, closesAt: null, serverNow: now };
    }
    const targetRound = latest.round + 1;
    const closesAt = drawMs(targetRound) - SUBMIT_CLOSE_BEFORE_DRAW_MS;
    // 이미 끝난 추첨 결과를 아직 못 받아온 상태(latest < expected)에선 접수하지 않는다.
    const canSubmit = latest.round >= expected && now < closesAt;
    return {
        drawnRound: latest.round,
        numbers: latest.numbers,
        bonus: latest.bonus,
        targetRound,
        canSubmit,
        closesAt,
        serverNow: now,
    };
}

const handler = async (req, res) => {
    if (applyCors(req, res)) return;

    try {
        // Vercel 크론(GET): 추첨 직후 결과를 미리 저장해 둔다. CRON_SECRET이 있어야만 동작.
        if (req.method === "GET") {
            const secret = process.env.CRON_SECRET;
            if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
                return res.status(401).json({ error: "unauthorized" });
            }
            const state = await ensureSynced();
            return res.status(200).json({ ok: true, drawnRound: state.latest ? state.latest.round : null });
        }
        if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

        const { uid } = await requireAuth(req);
        const body = req.body || {};

        if (body.action === "status") {
            const state = await ensureSynced();
            return res.status(200).json(buildStatus(state, Date.now()));
        }

        if (body.action === "submit") {
            const numbers = (Array.isArray(body.numbers) ? body.numbers : []).map(Number);
            const bonus = Number(body.bonus);
            const valid =
                numbers.length === 6 && numbers.every(isBall) && isBall(bonus) &&
                new Set([...numbers, bonus]).size === 7;
            if (!valid) return res.status(400).json({ error: "bad_numbers" });

            const state = await ensureSynced();
            const status = buildStatus(state, Date.now());
            if (!status.targetRound) return res.status(503).json({ error: "syncing" });
            if (!status.canSubmit) {
                const stillSyncing = state.latest && state.latest.round < state.expected;
                return res.status(stillSyncing ? 503 : 403).json({ error: stillSyncing ? "syncing" : "closed" });
            }

            const ref = db().ref(`lotto_predictions/${status.targetRound}/${uid}`);
            const sorted = numbers.sort((a, b) => a - b);
            const result = await ref.transaction((cur) => (cur ? undefined : { numbers: sorted, bonus, submittedAt: Date.now() }));
            if (!result.committed) return res.status(409).json({ error: "already_submitted" });
            await grantLottoParticipationBadges(uid, status.targetRound).catch((e) => console.error("로또 참여 배지 지급 실패:", e.message));
            return res.status(200).json({ ok: true, targetRound: status.targetRound, numbers: sorted, bonus });
        }

        return res.status(400).json({ error: "bad_action" });
    } catch (err) {
        const status = err.statusCode || 500;
        return res.status(status).json({ error: status === 500 ? "server_error" : err.message });
    }
};

// 마스터 도구(api/admin.js)용
handler.expectedLatestRound = expectedLatestRound;
handler.finalizeRound = finalizeRound;
handler.isBall = isBall;
handler.syncNow = async () => {
    await db().ref("lottoMeta").update({ lockUntil: 0, lastAttemptAt: 0 }); // 호출 간격 제한 해제
    return ensureSynced();
};
module.exports = handler;
