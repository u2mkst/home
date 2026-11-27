// 남용 재현용: 로그인한 학생 한 명이 메시지·문의·기기 상태를 연타하거나 쓰레기 데이터를 붙이는 시도가 막히는지 숫자로 보여 준다.
// 실행: npm run abuse  (규칙을 고치기 전/후를 비교할 때 RULES_FILE=이전규칙.json 으로 돌려 본다)
const fs = require('fs');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const TS = { '.sv': 'timestamp' };
(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-kst', database: { host: '127.0.0.1', port: 9199, rules: fs.readFileSync(process.env.RULES_FILE || require('path').join(__dirname, '..', '..', 'database.rules.json'), 'utf8') } });
  const d = env.authenticatedContext('stu1').database();
  const count = async (n, fn) => { let ok = 0; for (let i = 0; i < n; i++) { try { await fn(i); ok++; } catch (e) {} } return ok; };
  const N = 50;
  const m = await count(N, () => d.ref('messages').push({ studentName: '김', studentUid: 'stu1', teacher: 't', message: 'x', timestamp: TS, read: false }));
  const s = await count(N, () => d.ref('suggestions').push({ studentUid: 'stu1', content: 'x', timestamp: TS }));
  const v = await count(N, () => d.ref('device_status/stu1').set({ battery: 80, lastUpdated: TS }));
  const big = await count(1, () => d.ref('messages').push({ studentName: '김', studentUid: 'stu1', teacher: 't', message: 'x', timestamp: TS, junk: 'J'.repeat(500000) }));
  const fake = await count(1, () => d.ref('student_messages/stu1').push({ text: '가짜 공지', read: false }));
  const inj = await count(1, () => d.ref('messages').push({ studentName: '김', studentUid: 'stu1', teacher: 't', message: 'x', timestamp: TS, replies: { r1: { text: '가짜 선생님 답글' } } }));
  console.log(`messages 연속 ${N}건 중 성공: ${m}`); console.log(`suggestions 연속 ${N}건 중 성공: ${s}`); console.log(`device_status 연속 ${N}회 중 성공: ${v}`);
  console.log(`메시지에 500KB 쓰레기 필드 붙이기 성공 여부: ${big ? '성공(막히지 않음)' : '막힘'}`);
  console.log(`학생이 자기에게 가짜 알림 만들기: ${fake ? '성공(막히지 않음)' : '막힘'}`);
  console.log(`메시지에 가짜 선생님 답글 끼워넣기: ${inj ? '성공(막히지 않음)' : '막힘'}`);
  await env.cleanup(); process.exit(0);
})();
