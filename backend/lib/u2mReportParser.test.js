/* u2mReportParser.js 단위 테스트. 네트워크·자격증명 전혀 없이 HTML 문자열만
   가지고 돌아간다. 실행: node backend/lib/u2mReportParser.test.js
   (이 저장소에 아직 테스트 러너가 없어서 플레인 Node 스크립트로 작성 — 다른
   폴더에서 이 세션 동안 써온 것과 같은 가벼운 방식.)

   fixture 데이터는 전부 가상의 과정명·숫자다(실제 학생 보고서 원문 아님). */
'use strict';
const assert = require('assert');
const { parseMonthlyReport, looksLikeLoginPage, parsePercentLike } = require('./u2mReportParser');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', msg); } }

function card({ period = '2026-01-01 ~ 2026-01-07', title = '[과정1]테스트과정(가상)', achv = '77.5', com = '60', wrapTag = 'div', extraNesting = false } = {}) {
    const body = `
      <div class="sep">${period}</div>
      <div class="card_tit"><span class="badge">NEW</span><div class="tit">${title}</div></div>
      <div class="achv_level"><span class="lbl">성취도</span><div class="num">${achv}</div></div>
      <div class="com_level"><span class="lbl">이수도</span><div class="num">${com}</div></div>
    `;
    const wrapped = extraNesting ? `<div class="deco"><div class="inner">${body}</div></div>` : body;
    return `<${wrapTag} class="card_wrap foo">${wrapped}</${wrapTag}>`;
}

console.log('[카드 2개 정상 추출]');
{
    const html = `<html><body><div id="list">${card({ title: '[과정1]공통수학1-가상상(2022개정)', achv: '82.98', com: '95' })}${card({ title: '[과정2]중3-2가상-하', achv: '88.89', com: '50' })}</div></body></html>`;
    const r = parseMonthlyReport(html);
    ok(r.status === 'ok', 'status=ok: ' + r.status);
    ok(r.reports.length === 2, '카드 2개: ' + r.reports.length);
    ok(r.reports[0].courseName === '[과정1]공통수학1-가상상(2022개정)', '과정명(한글+괄호+특수문자) 보존: ' + r.reports[0].courseName);
    ok(r.reports[0].achievement === 82.98 && typeof r.reports[0].achievement === 'number', '성취도 number 타입: ' + JSON.stringify(r.reports[0].achievement));
    ok(r.reports[1].completion === 50, '두번째 카드 이수도: ' + r.reports[1].completion);
}

console.log('[카드 여러 개(3개 이상)]');
{
    const html = card({ title: 'A과정' }) + card({ title: 'B과정' }) + card({ title: 'C과정' });
    const r = parseMonthlyReport(html);
    ok(r.reports.length === 3, '3개 모두 추출: ' + r.reports.length);
}

console.log('[네스트된 div가 있는 카드(중첩 구조 — 단순 정규식이면 깨짐)]');
{
    const html = card({ title: '중첩테스트', achv: '70', com: '80', extraNesting: true });
    const r = parseMonthlyReport(html);
    ok(r.status === 'ok' && r.reports.length === 1, '중첩 있어도 블록 경계 정확히 찾음: ' + JSON.stringify(r));
    ok(r.reports[0].achievement === 70, '중첩 속 achv 값: ' + r.reports[0].achievement);
}

console.log('[보고서 없음(빈 상태) — U2M 페이지인 건 맞음]');
{
    const html = '<html><body><div class="u2math-footer">swgwanggyo.u2math.co.kr</div><div class="empty-msg">해당 월의 학습 보고서가 없습니다.</div></body></html>';
    const r = parseMonthlyReport(html);
    ok(r.status === 'empty', '빈 보고서로 분류: ' + r.status);
    ok(r.reports.length === 0, '카드 0개');
}

console.log('[사이트 구조가 완전히 바뀐 경우]');
{
    const html = '<html><body><h1>알 수 없는 페이지</h1><p>전혀 다른 레이아웃</p></body></html>';
    const r = parseMonthlyReport(html);
    ok(r.status === 'structure_changed', '구조 변경으로 분류(빈 보고서로 숨기지 않음): ' + r.status);
}

console.log('[선택자 일부 누락된 카드]');
{
    const html = `<div class="card_wrap"><div class="card_tit"><div class="tit">제목만 있음</div></div></div>`;
    const r = parseMonthlyReport(html);
    ok(r.status === 'ok', 'status=ok(서버 전체가 중단되지 않음): ' + r.status);
    ok(r.reports.length === 1, '카드 자체는 만들어짐');
    ok(r.reports[0].period === null, 'period 없음 -> null(빈 문자열로 날조 안 함)');
    ok(r.reports[0].achievement === null, 'achv_level 자체가 없음 -> achievement null');
    ok(r.reports[0].warnings.includes('period_missing') && r.reports[0].warnings.includes('achievement_missing'), '경고 목록에 기록됨: ' + JSON.stringify(r.reports[0].warnings));
}

console.log('[성취도/이수도에 숫자가 없는 경우]');
{
    const html = card({ achv: '집계중', com: 'N/A' });
    const r = parseMonthlyReport(html);
    ok(r.reports[0].achievement === null, '숫자 아님 -> null(0으로 단정 안 함): ' + r.reports[0].achievement);
    ok(r.reports[0].raw.achievementText === '집계중', '원문 텍스트는 raw에 보존: ' + r.reports[0].raw.achievementText);
    ok(r.reports[0].warnings.includes('achievement_no_number'), '오류 사유 구분됨');
}

console.log('[범위를 벗어난 숫자(예: 음수, 100 초과)는 오류로 처리]');
{
    const r1 = parsePercentLike('150');
    ok(r1.value === null && r1.error === 'out_of_range', '150 -> out_of_range: ' + JSON.stringify(r1));
    const r2 = parsePercentLike('-5');
    ok(r2.value === null && r2.error === 'out_of_range', '-5 -> out_of_range: ' + JSON.stringify(r2));
}

console.log('[로그인 페이지 HTML을 보고서로 착각하지 않음]');
{
    const loginHtml = `<html><body><form><input type="text" name="LOGIN_ID"><input type="password" name="LOGIN_PWD"><button class="login_btn">로그인</button></form></body></html>`;
    ok(looksLikeLoginPage(loginHtml), 'looksLikeLoginPage=true');
    const r = parseMonthlyReport(loginHtml);
    ok(r.status === 'login_required', '로그인 필요로 분류(보고서로 저장 안 함): ' + r.status);
    ok(r.reports.length === 0, '보고서 0개(로그인 페이지를 카드로 잘못 파싱 안 함)');
}

console.log('[HTML 엔티티 / 퍼센트 기호 / 쉼표 소수점 처리]');
{
    const html = card({ title: '수학&amp;과학&nbsp;융합반', achv: '82.98%', com: '95,5' });
    const r = parseMonthlyReport(html);
    ok(r.reports[0].courseName === '수학&과학 융합반', '엔티티 디코드: ' + r.reports[0].courseName);
    ok(r.reports[0].achievement === 82.98, '%기호 있어도 숫자만 추출: ' + r.reports[0].achievement);
    ok(r.reports[0].completion === 95.5, '쉼표 소수점도 처리: ' + r.reports[0].completion);
}

console.log('[<script> 태그는 실행하지 않고 텍스트에서도 제거]');
{
    const html = `<div class="card_wrap"><div class="sep">2026-01-01 ~ 2026-01-07<script>document.title='hacked'</script></div><div class="card_tit"><div class="tit">정상과정</div></div><div class="achv_level"><div class="num">50</div></div><div class="com_level"><div class="num">50</div></div></div>`;
    const r = parseMonthlyReport(html);
    ok(!r.reports[0].period.includes('hacked'), 'script 내용이 텍스트에 안 섞임: ' + r.reports[0].period);
}

console.log('[완전히 동일한 카드 중복 제거]');
{
    const html = card({ title: '중복과정', achv: '60', com: '70' }) + card({ title: '중복과정', achv: '60', com: '70' });
    const r = parseMonthlyReport(html);
    ok(r.reports.length === 1, '똑같은 카드 2번 -> 1개로 합쳐짐: ' + r.reports.length);
}

console.log('[잘못된 입력]');
{
    ok(parseMonthlyReport('').status === 'invalid_input', '빈 문자열 -> invalid_input');
    ok(parseMonthlyReport(null).status === 'invalid_input', 'null -> invalid_input');
    ok(parseMonthlyReport(undefined).status === 'invalid_input', 'undefined -> invalid_input');
}

console.log('[실제 사용자가 확인한 실제 구조와 동일한 모양(가상의 값으로 재현)]');
{
    // 사용자가 실제 브라우저에서 확인했다고 전달한 "모양"만 재현한 것이며,
    // 숫자·과정명은 전부 가상값이다(실제 학생 데이터 아님).
    const html = `
      <div class="card_wrap">
        <div class="card_tit"><div class="tit">[과정1]샘플과정-가상(2022개정)</div></div>
        <div class="sep">2026-01-02 ~ 2026-01-07</div>
        <div class="achv_level"><div class="num">70.5</div></div>
        <div class="com_level"><div class="num">40</div></div>
      </div>`;
    const r = parseMonthlyReport(html);
    ok(r.status === 'ok' && r.reports.length === 1, '단일 카드 정상 추출');
    ok(r.reports[0].courseName === '[과정1]샘플과정-가상(2022개정)' && r.reports[0].period === '2026-01-02 ~ 2026-01-07', '필드 순서가 달라도(card_tit가 sep보다 먼저 나와도) 정확히 매칭: ' + JSON.stringify(r.reports[0]));
}

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
