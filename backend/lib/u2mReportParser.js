/* ============================================================================
   U2M 월간 학습 보고서 HTML 파서 (lib/u2mReportParser.js)
   ----------------------------------------------------------------------------
   ⚠️ 이 모듈은 HTML "문자열"만 입력으로 받는 순수 파싱 유틸이다. 네트워크 요청을
   하지 않고, U2M에 로그인하지 않고, 자격증명을 다루지 않는다. 어디서 HTML을
   가져올지는 이 모듈의 책임이 아니다(그 부분은 아직 구현하지 않았다 — 이유는
   README의 "U2M 연동 검증 메모" 참고).

   입력 HTML은 사용자가 설명한 구조를 가정한다:
     .card_wrap           보고서 카드 하나
       .sep                  학습 기간
       .card_tit .tit        과정명
       .achv_level .num      성취도
       .com_level .num       이수도

   의존성 없이(cheerio/jsdom 추가 없이) 태그 스택을 직접 따라가며 블록 경계를
   찾는다 — 네스트된 div까지 가는 단순 정규식([\s\S]*?)은 중첩 구조에서 쉽게
   틀리기 때문이다.
============================================================================ */
'use strict';

// class 속성에 className이 "단어 단위로" 포함된 시작 태그를 찾는다
// (class="card_wrap foo"는 맞고 class="my-card_wrap"는 아니어야 함).
function findStartTags(html, className) {
    const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\bclass\s*=\s*(".*?"|'.*?')([^>]*)>/g;
    const results = [];
    let m;
    while ((m = re.exec(html))) {
        const tag = m[1];
        const classAttr = m[3].slice(1, -1);
        const classes = classAttr.split(/\s+/);
        if (classes.includes(className)) {
            results.push({ tag, start: m.index, afterOpenTag: re.lastIndex, selfClosing: /\/\s*>$/.test(m[0]) });
        }
    }
    return results;
}

// 시작 태그 바로 뒤(afterOpenTag)부터 같은 태그 이름의 열고 닫음 개수를 세어
// 그 블록이 끝나는 위치(닫는 태그 다음 인덱스)를 찾는다. void 태그(img, br 등)는
// 애초에 class를 가진 wrapper로 거의 안 쓰이므로 별도 처리하지 않는다.
function findBlockEnd(html, tag, afterOpenTag) {
    const openRe = new RegExp('<' + tag + '(?:\\s[^>]*)?>', 'gi');
    const closeRe = new RegExp('<\\/' + tag + '\\s*>', 'gi');
    let depth = 1;
    let pos = afterOpenTag;
    while (depth > 0) {
        openRe.lastIndex = pos; closeRe.lastIndex = pos;
        const nextOpen = openRe.exec(html);
        const nextClose = closeRe.exec(html);
        if (!nextClose) return html.length; // 안 닫힘(깨진 HTML) -> 문자열 끝까지로 취급
        if (nextOpen && nextOpen.index < nextClose.index) {
            depth++; pos = nextOpen.index + nextOpen[0].length;
        } else {
            depth--; pos = nextClose.index + nextClose[0].length;
            if (depth === 0) return pos;
        }
    }
    return pos;
}

// class="X"인 첫 블록 하나의 {outerHtml, innerHtml}를 돌려준다(없으면 null).
function firstBlockByClass(html, className) {
    const tags = findStartTags(html, className);
    if (!tags.length) return null;
    const t = tags[0];
    if (t.selfClosing) return { outer: html.slice(t.start, t.afterOpenTag), inner: '' };
    const end = findBlockEnd(html, t.tag, t.afterOpenTag);
    const closeLen = ('</' + t.tag + '>').length;
    return { outer: html.slice(t.start, end), inner: html.slice(t.afterOpenTag, end - closeLen) };
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

// 태그를 걷어내고 HTML 엔티티를 풀어서 보이는 텍스트만 남긴다(innerText 흉내).
function stripToText(html) {
    if (!html) return '';
    // <script>/<style> 내용은 절대 실행하지 않고 통째로 버린다.
    let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (full, ent) => {
        if (ent[0] === '#') {
            const code = ent[1].toLowerCase() === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : full;
        }
        const key = ent.toLowerCase();
        return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : full;
    });
    return s.replace(/\s+/g, ' ').trim();
}

function textOfFirst(html, className) {
    const b = firstBlockByClass(html, className);
    return b ? stripToText(b.inner) : null;
}

// "82.98" "82.98%" "82,98" 같은 표기에서 0~100 범위의 유효한 숫자만 뽑는다.
// 못 찾으면 null(= 0으로 단정하지 않음 — 파싱 실패와 "진짜 0점"을 구분해야 함).
function parsePercentLike(text) {
    if (text == null) return { value: null, raw: text, error: 'missing' };
    const m = String(text).match(/-?\d+(?:[.,]\d+)?/);
    if (!m) return { value: null, raw: text, error: 'no_number' };
    const n = Number(m[0].replace(',', '.'));
    if (!Number.isFinite(n)) return { value: null, raw: text, error: 'not_finite' };
    if (n < 0 || n > 100) return { value: null, raw: text, error: 'out_of_range' };
    return { value: n, raw: text, error: null };
}

// HTML이 "로그인 페이지"처럼 보이는지 — U2M 로그인 폼 셀렉터는 이미 코드베이스의
// Android 브릿지(injectOriginalU2MCode)에서 쓰고 있는 것과 같은 걸 재사용한다
// (input[name="LOGIN_ID"], input[name="LOGIN_PWD"], .login_btn).
function looksLikeLoginPage(html) {
    return /name\s*=\s*["']LOGIN_ID["']/i.test(html) || /name\s*=\s*["']LOGIN_PWD["']/i.test(html) || /class\s*=\s*["'][^"']*\blogin_btn\b/i.test(html);
}

/**
 * U2M 월간 보고서 HTML 문자열을 파싱한다.
 * @param {string} html
 * @returns {{status: 'ok'|'login_required'|'empty'|'structure_changed'|'invalid_input', reports: Array, warnings: string[]}}
 */
function parseMonthlyReport(html) {
    if (typeof html !== 'string' || !html.trim()) {
        return { status: 'invalid_input', reports: [], warnings: ['empty_or_non_string_input'] };
    }
    if (looksLikeLoginPage(html)) {
        return { status: 'login_required', reports: [], warnings: [] };
    }

    const cardTags = findStartTags(html, 'card_wrap');
    if (!cardTags.length) {
        // card_wrap이 아예 없다 — 그 달에 보고서가 없는 "정상적인 빈 상태"일 수도,
        // 사이트 구조가 바뀌어 셀렉터 자체가 안 맞는 것일 수도 있다. 완전히 다른
        // 핵심 마크업(예: U2M 자체 로고/네비게이션 흔적)마저 없다면 후자로 본다.
        const looksLikeU2mAtAll = /u2math/i.test(html) || /swgwanggyo/i.test(html);
        return { status: looksLikeU2mAtAll ? 'empty' : 'structure_changed', reports: [], warnings: [] };
    }

    const reports = [];
    const warnings = [];
    const seen = new Set();

    cardTags.forEach((t, idx) => {
        if (t.selfClosing) { warnings.push(`card_wrap #${idx}: self-closing, 건너뜀`); return; }
        const end = findBlockEnd(html, t.tag, t.afterOpenTag);
        const closeLen = ('</' + t.tag + '>').length;
        const inner = html.slice(t.afterOpenTag, end - closeLen);

        const period = textOfFirst(inner, 'sep');
        const titBlock = firstBlockByClass(inner, 'card_tit');
        const courseName = titBlock ? textOfFirst(titBlock.inner, 'tit') : null;
        const achvBlock = firstBlockByClass(inner, 'achv_level');
        const comBlock = firstBlockByClass(inner, 'com_level');
        const achievement = parsePercentLike(achvBlock ? textOfFirst(achvBlock.inner, 'num') : null);
        const completion = parsePercentLike(comBlock ? textOfFirst(comBlock.inner, 'num') : null);

        const cardWarnings = [];
        if (!period) cardWarnings.push('period_missing');
        if (!courseName) cardWarnings.push('courseName_missing');
        if (achievement.error) cardWarnings.push('achievement_' + achievement.error);
        if (completion.error) cardWarnings.push('completion_' + completion.error);

        const report = {
            courseName: courseName || null,
            period: period || null,
            achievement: achievement.value,
            completion: completion.value,
            raw: { achievementText: achievement.raw, completionText: completion.raw },
            warnings: cardWarnings
        };

        const dedupeKey = JSON.stringify([report.courseName, report.period, report.achievement, report.completion]);
        if (seen.has(dedupeKey)) { warnings.push(`card_wrap #${idx}: 바로 앞 카드와 완전히 동일(중복) → 제외`); return; }
        seen.add(dedupeKey);
        reports.push(report);
    });

    if (!reports.length) return { status: 'structure_changed', reports: [], warnings: warnings.concat(['all_cards_self_closing']) };
    return { status: 'ok', reports, warnings };
}

module.exports = { parseMonthlyReport, looksLikeLoginPage, parsePercentLike, stripToText };
