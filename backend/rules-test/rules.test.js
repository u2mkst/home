// Firebase 규칙(database.rules.json) 검증: 실제 Realtime Database 에뮬레이터에서 학생·관리자 시나리오를 돌린다.
// 실행: cd backend/rules-test && npm install && npm test   (Java 11+ 필요)
const fs = require('fs');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const path = require('path');
const RULES = process.env.RULES_FILE || path.join(__dirname, '..', '..', 'database.rules.json');
const ADMIN = '9temrm7WfSXRKo5v5jJiz65t8yF2', MASTER = 'OUcTOJNMDVXaMwouAqUluSvd2nH2';
const TS = { '.sv': 'timestamp' };
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ FAIL: ' + name + '  → ' + String(e.message).split('\n')[0].slice(0, 110)); } }
const db = (env, uid) => env.authenticatedContext(uid).database();

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-kst', database: { host: '127.0.0.1', port: 9199, rules: fs.readFileSync(RULES, 'utf8') } });
  const reset = async (seed) => { await env.clearDatabase(); if (seed) await env.withSecurityRulesDisabled(async c => { await c.database().ref().update(seed); }); };
  const msg = (uid, extra) => Object.assign({ studentName: '김학생', u2mId: 'u2m1', studentUid: uid, teacher: '김동진', message: 'cipher', timestamp: TS, read: false }, extra || {});
  const sendMsg = (d, uid, extra, throttle = true) => { const key = d.ref('messages').push().key; const u = { [`messages/${key}`]: msg(uid, extra) }; if (throttle) u[`writeThrottle/${uid}/messages`] = TS; return d.ref().update(u); };
  const sendSug = (d, uid, extra, throttle = true) => { const key = d.ref('suggestions').push().key; const u = { [`suggestions/${key}`]: Object.assign({ studentName: '김학생', studentUid: uid, schoolName: '학교', category: '학원에 문의하기', content: 'cipher', author: '', authorProfile: '', timestamp: TS }, extra || {}) }; if (throttle) u[`writeThrottle/${uid}/suggestions`] = TS; return d.ref().update(u); };
  const old = (kind, uid, ms) => ({ [`writeThrottle/${uid}/${kind}`]: Date.now() - ms });

  console.log('[1] 학생 메시지(messages) — 연속 전송 제한');
  await reset();
  const s1 = db(env, 'stu1');
  await t('처음 보내기는 성공', () => assertSucceeds(sendMsg(s1, 'stu1')));
  await t('바로 또 보내기(3초 안)는 막힘', () => assertFails(sendMsg(s1, 'stu1')));
  await t('여러 번 연속으로 보내도 막힘', async () => { for (let i = 0; i < 5; i++) await assertFails(sendMsg(s1, 'stu1')); });
  await t('다른 학생은 영향 없이 보낼 수 있음', () => assertSucceeds(sendMsg(db(env, 'stu2'), 'stu2')));
  await reset(old('messages', 'stu1', 5000));
  await t('3초가 지나면 다시 보낼 수 있음', () => assertSucceeds(sendMsg(db(env, 'stu1'), 'stu1')));
  await reset();
  await t('제한 기록을 같이 안 남기고 보내면 막힘(우회 시도)', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', null, false)));
  await t('timestamp를 서버 시각이 아닌 값으로 속이면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', { timestamp: 123 })));
  await t('다른 학생 UID로 보내면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu2')));
  await t('가짜 선생님 답글(replies)을 끼워 넣으면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', { replies: { r1: { text: 'x', teacher: '김동진' } } })));
  await t('정의되지 않은 필드를 잔뜩 붙이면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', { junk: 'x'.repeat(1000) })));
  await t('메시지가 비어 있으면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', { message: '' })));
  await t('메시지가 5000자 이상이면 막힘', () => assertFails(sendMsg(db(env, 'stu1'), 'stu1', { message: 'a'.repeat(5000) })));
  await t('제한 기록을 미래/과거 시각으로 조작하면 막힘', async () => {
    await assertFails(db(env, 'stu1').ref('writeThrottle/stu1/messages').set(Date.now() + 999999));
    await assertFails(db(env, 'stu1').ref('writeThrottle/stu1/messages').set(1));
  });
  await t('다른 학생의 제한 기록은 못 건드림', () => assertFails(db(env, 'stu1').ref('writeThrottle/stu2/messages').set(TS)));
  await t('제한 기록은 읽을 수 없음', () => assertFails(db(env, 'stu1').ref('writeThrottle/stu1/messages').get()));
  await reset();
  await sendMsg(db(env, 'stu1'), 'stu1');
  let mid;
  await env.withSecurityRulesDisabled(async c => { mid = Object.keys((await c.database().ref('messages').get()).val())[0]; });
  await t('학생은 이미 보낸 메시지를 고칠 수 없음', () => assertFails(db(env, 'stu1').ref(`messages/${mid}/message`).set('바꿈')));
  await t('선생님(관리자)은 답글을 달 수 있음(제한 기록 없이)', () => assertSucceeds(db(env, ADMIN).ref(`messages/${mid}/replies`).push({ text: 'ok', teacher: '김동진', timestamp: TS })));
  await t('선생님은 메시지에 읽음 표시 등 다른 필드도 수정 가능', () => assertSucceeds(db(env, ADMIN).ref(`messages/${mid}`).update({ read: true, repliedAt: TS })));
  await t('학생은 자기 메시지 목록을 읽을 수 있음', () => assertSucceeds(db(env, 'stu1').ref('messages').orderByChild('studentUid').equalTo('stu1').get()));

  console.log('[2] 문의(suggestions) — 연속 전송 제한');
  await reset();
  await t('처음 문의는 성공', () => assertSucceeds(sendSug(db(env, 'stu1'), 'stu1')));
  await t('바로 또 문의하면 막힘(30초)', () => assertFails(sendSug(db(env, 'stu1'), 'stu1')));
  await reset(old('suggestions', 'stu1', 31000));
  await t('30초가 지나면 가능', () => assertSucceeds(sendSug(db(env, 'stu1'), 'stu1')));
  await reset();
  await t('제한 기록 없이 보내면 막힘', () => assertFails(sendSug(db(env, 'stu1'), 'stu1', null, false)));
  await t('다른 UID로 보내면 막힘', () => assertFails(sendSug(db(env, 'stu1'), 'stu2')));
  await t('정의되지 않은 필드를 붙이면 막힘', () => assertFails(sendSug(db(env, 'stu1'), 'stu1', { junk: 'x' })));
  await t('내용이 5000자 이상이면 막힘', () => assertFails(sendSug(db(env, 'stu1'), 'stu1', { content: 'a'.repeat(5000) })));
  await t('학생은 문의 목록을 읽을 수 없음', () => assertFails(db(env, 'stu1').ref('suggestions').get()));
  await t('마스터는 읽을 수 있음', () => assertSucceeds(db(env, MASTER).ref('suggestions').get()));

  console.log('[3] 기기 상태(device_status) — 쓰기 주기 제한');
  await reset();
  const dev = (d, uid, v) => d.ref(`device_status/${uid}`).set(v || { battery: 80, lastUpdated: TS });
  await t('처음 보고는 성공', () => assertSucceeds(dev(db(env, 'stu1'), 'stu1')));
  await t('바로 또 쓰면 막힘(20초)', () => assertFails(dev(db(env, 'stu1'), 'stu1')));
  await reset({ 'device_status/stu1': { battery: 50, lastUpdated: Date.now() - 61000 } });
  await t('60초 주기 보고는 성공(정상 사용)', () => assertSucceeds(dev(db(env, 'stu1'), 'stu1')));
  await reset();
  await t('다른 학생 기기 상태는 못 씀', () => assertFails(dev(db(env, 'stu1'), 'stu2')));
  await t('배터리 값이 범위(0~100)를 벗어나면 막힘', () => assertFails(dev(db(env, 'stu1'), 'stu1', { battery: 500, lastUpdated: TS })));
  await t('정의되지 않은 필드를 붙이면 막힘', () => assertFails(dev(db(env, 'stu1'), 'stu1', { battery: 80, lastUpdated: TS, junk: 'x'.repeat(500) })));
  await t('lastUpdated를 서버 시각이 아닌 값으로 속이면 막힘', () => assertFails(dev(db(env, 'stu1'), 'stu1', { battery: 80, lastUpdated: 1 })));
  await t('선생님(관리자)은 읽을 수 있음', () => assertSucceeds(db(env, ADMIN).ref('device_status/stu1').get()));

  console.log('[4] 학생 알림(student_messages) — 학생은 "읽음" 표시만');
  await reset({ 'student_messages/stu1/m1': { text: '안내', read: false, timestamp: 1 } });
  await t('학생이 자기 알림을 읽음으로 표시(정상 사용)', () => assertSucceeds(db(env, 'stu1').ref('student_messages/stu1/m1').update({ read: true })));
  await t('학생이 자기 알림 내용을 바꾸면 막힘', () => assertFails(db(env, 'stu1').ref('student_messages/stu1/m1/text').set('조작')));
  await t('학생이 가짜 알림을 새로 만들면 막힘', () => assertFails(db(env, 'stu1').ref('student_messages/stu1').push({ text: '가짜', read: false })));
  await t('없는 알림에 읽음 표시로 빈 항목을 만들면 막힘', () => assertFails(db(env, 'stu1').ref('student_messages/stu1/ghost').update({ read: true })));
  await t('다른 학생 알림은 못 건드림', () => assertFails(db(env, 'stu2').ref('student_messages/stu1/m1').update({ read: true })));
  await t('선생님(관리자)은 알림을 보낼 수 있음', () => assertSucceeds(db(env, ADMIN).ref('student_messages/stu1').push({ text: '답변', read: false, timestamp: TS })));
  await t('학생은 자기 알림을 읽을 수 있음', () => assertSucceeds(db(env, 'stu1').ref('student_messages/stu1').orderByChild('read').equalTo(false).get()));

  console.log('[5] 오늘의 문제(mathQuizProgress) — 모양 제한');
  await reset();
  const q = (d, uid, v) => d.ref(`mathQuizProgress/${uid}/20261126`).update(v);
  await t('정상 저장(correctIndexes + updatedAt)은 성공', () => assertSucceeds(q(db(env, 'stu1'), 'stu1', { 'correctIndexes/3': true, updatedAt: TS })));
  await t('인덱스가 숫자가 아니면 막힘', () => assertFails(q(db(env, 'stu1'), 'stu1', { 'correctIndexes/abc': true })));
  await t('값이 true가 아니면 막힘', () => assertFails(q(db(env, 'stu1'), 'stu1', { 'correctIndexes/2': 'x'.repeat(500) })));
  await t('정의되지 않은 필드를 붙이면 막힘', () => assertFails(q(db(env, 'stu1'), 'stu1', { junk: 'x'.repeat(500) })));
  await t('다른 학생 것은 못 씀', () => assertFails(q(db(env, 'stu2'), 'stu1', { 'correctIndexes/1': true })));

  console.log('[6] 기존 동작이 그대로인지');
  await reset({ 'students/stu1': { name: 'c', teacher: '김동진' } });
  await t('학생이 자기 student 정보 수정(기존 동작 유지)', () => assertSucceeds(db(env, 'stu1').ref('students/stu1').update({ darkMode: true })));
  await t('학생이 업적(quiz_N)을 기록', () => assertSucceeds(db(env, 'stu1').ref('studentAchievements/stu1/quiz_5').set(true)));
  await t('학생이 다른 업적은 못 기록', () => assertFails(db(env, 'stu1').ref('studentAchievements/stu1/attendance_gold').set(true)));
  await t('로그인 안 한 사용자는 아무것도 못 씀', async () => { const a = env.unauthenticatedContext().database(); await assertFails(a.ref('messages').push(msg('stu1'))); });
  await t('공지/자막은 관리자만 씀', async () => { await assertFails(db(env, 'stu1').ref('notice').set('x')); await assertSucceeds(db(env, ADMIN).ref('notice').set('x')); });

  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
