const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 서버 시각 기준 한국 날짜 문자열 (YYYY-MM-DD, YYYY-MM)
function kstDateParts(nowMs = Date.now()) {
    const d = new Date(nowMs + KST_OFFSET_MS);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return { yearMonth: `${y}-${m}`, date: `${y}-${m}-${day}` };
}

module.exports = { KST_OFFSET_MS, kstDateParts };
