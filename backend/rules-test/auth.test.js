// 로그인 보안 통합 테스트: 실제 핸들러(student-login / admin / adminLogin)를 Auth+Database 에뮬레이터 위에서 호출한다.
const h = require('./harness');
const { admin, call, DAY, H } = h;
const login = require(h.BACKEND + '/api/student-login');
const adminApi = require(h.BACKEND + '/api/admin');
const { hashPin, verifyPin } = require(h.BACKEND + '/lib/pin');
const { encryptOne } = require(h.BACKEND + '/lib/aes');
const ADMIN_UID = '9temrm7WfSXRKo5v5jJiz65t8yF2', MASTER_UID = 'OUcTOJNMDVXaMwouAqUluSvd2nH2';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const db = () => admin.database();
let ipc = 0; const newIp = () => `10.1.${(ipc >> 8) & 255}.${++ipc & 255}`;

async function mkStudent(id, pin, mode) { // mode: 'migrated' | 'legacy'
  const u = await admin.auth().createUser({ email: `${id}@kst.com`, password: mode === 'migrated' ? 'Zx9!qA' : '00' + pin });
  if (mode === 'migrated') await db().ref(`loginSecrets/${u.uid}`).set({ ...hashPin(pin), randomized: true });
  await db().ref(`students/${u.uid}`).set({ u2mId: id, phone: encryptOne(process.env.AES_KEY, pin), name: 'x' });
  return u;
}

(async () => {
  console.log('[1] 잠금 단계 · 기억 기간');
  const q = require(h.BACKEND + '/lib/quota');
  ok(q.computeLockoutMs(2) === 0 && q.computeLockoutMs(3) === 30000 && q.computeLockoutMs(5) === 120000 && q.computeLockoutMs(8) === 600000 && q.computeLockoutMs(12) === 3600000 && q.computeLockoutMs(30) === 86400000, '학생 잠금 단계 3/5/8/12/30회');
  ok(q.computeAdminLockoutMs(2) === 0 && q.computeAdminLockoutMs(3) === 60000 && q.computeAdminLockoutMs(8) === 3600000 && q.computeAdminLockoutMs(99) === 3600000, '관리자 잠금 단계(최대 1시간)');
  ok(q.FAIL_MEMORY_MS === 30 * DAY, '실패 기억 30일');

  console.log('[2] 학생: 한 계정 분산 공격 30일 시뮬레이션');
  await mkStudent('ufes0001', '9999', 'migrated');
  let guess = 0, day0 = h.now(), dayCount = 0; const perDay = []; const end = h.now() + 30 * DAY; let cracked = false;
  while (h.now() < end) {
    const r = await call(login, { id: 'ufes0001', pin: String(guess).padStart(4, '0'), recaptchaToken: 't' }, newIp());
    if (r.code === 200) { cracked = true; break; }
    if (r.code === 401) { guess++; dayCount++; }
    else if (r.code === 429 && r.body.lockedUntil) h.setNow(Math.max(h.now() + 1000, r.body.lockedUntil + 1));
    else { console.log('   unexpected', r.code, r.body); break; }
    if (h.now() - day0 >= DAY) { perDay.push(dayCount); dayCount = 0; day0 = h.now(); }
  }
  ok(!cracked && guess <= 80, `30일 동안 평가된 대입 ${guess}회(이전 650회) — 하루별 ${perDay.slice(0, 8).join(',')}…`);

  console.log('[3] 학생: 정상 사용은 그대로');
  await mkStudent('ufes0002', '4821', 'migrated');
  let r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, newIp());
  ok(r.code === 200 && typeof r.body.token === 'string', '맞는 PIN으로 로그인');
  for (let i = 0; i < 2; i++) await call(login, { id: 'ufes0002', pin: '0000', recaptchaToken: 't' }, newIp());
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, newIp());
  ok(r.code === 200, '두 번 틀린 뒤 맞으면 바로 로그인(잠금 없음)');
  const ls = (await db().ref('loginLockouts/ufes0002').once('value')).val();
  ok(!ls, '로그인 성공하면 실패 기록 삭제');
  for (let i = 0; i < 3; i++) await call(login, { id: 'ufes0002', pin: '0000', recaptchaToken: 't' }, newIp());
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, newIp());
  ok(r.code === 429 && r.body.error === 'locked', '3번 연속 틀리면 30초 잠금(맞는 PIN도 잠시 거절)');
  h.advance(31000);
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, newIp());
  ok(r.code === 200, '30초 뒤에는 다시 로그인');

  console.log('[4] 학생: 한 IP로 여러 계정 스프레이');
  for (let i = 0; i < 80; i++) await mkStudent('ufes1' + String(i).padStart(3, '0'), '9999', 'migrated');
  h.advance(2 * H);
  let evaluated = 0, blocked = 0, firstBlockAt = -1;
  for (let i = 0; i < 80; i++) {
    const rr = await call(login, { id: 'ufes1' + String(i).padStart(3, '0'), pin: '1234', recaptchaToken: 't' }, '9.9.9.9');
    if (rr.code === 401) evaluated++; else if (rr.code === 429) { blocked++; if (firstBlockAt < 0) firstBlockAt = i; }
  }
  ok(evaluated === 40 && blocked === 40, `한 IP의 실패 로그인은 시간당 40번까지만 평가(이전 300): 평가 ${evaluated} / 차단 ${blocked}`);
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, '9.9.9.9');
  ok(r.code === 429 && r.body.error === 'ip_limited', '이미 실패를 많이 한 IP는 맞는 PIN이어도 잠시 차단');
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, '5.5.5.5');
  ok(r.code === 200, '다른 IP의 정상 로그인에는 영향 없음');
  h.advance(61 * 60 * 1000);
  r = await call(login, { id: 'ufes0002', pin: '4821', recaptchaToken: 't' }, '9.9.9.9');
  ok(r.code === 200, '1시간이 지나면 같은 IP도 다시 사용 가능');

  console.log('[5] 학생: 정상 사용자가 많은 학원 와이파이(같은 IP)는 걸리지 않는다');
  for (let i = 0; i < 30; i++) await mkStudent('ufes3' + String(i).padStart(3, '0'), '1357', 'migrated');
  let okCount = 0; for (let i = 0; i < 30; i++) { const rr = await call(login, { id: 'ufes3' + String(i).padStart(3, '0'), pin: '1357', recaptchaToken: 't' }, '7.7.7.7'); if (rr.code === 200) okCount++; }
  ok(okCount === 30, `같은 IP에서 학생 30명이 정상 로그인: ${okCount}/30 (성공은 "실패 상한"에 세지 않음)`);

  console.log('[6] 관리자·마스터 로그인: 서버 경유');
  await admin.auth().createUser({ uid: ADMIN_UID, email: 'admin@kst.com', password: 'Teach3rPass' });
  await admin.auth().createUser({ uid: MASTER_UID, email: 'master@kst.com', password: 'M@sterLongPassphrase99' });
  const A = (body, ip) => call(login, Object.assign({ admin: true }, body), ip || newIp());
  r = await A({ email: 'admin@kst.com', password: 'wrong' });
  ok(r.code === 401 && r.body.error === 'invalid', '틀린 비밀번호는 401');
  r = await A({ email: 'admin@kst.com', password: 'Teach3rPass' });
  ok(r.code === 200 && typeof r.body.token === 'string', '맞는 비밀번호는 커스텀 토큰 발급(첫 로그인 = 자동 이전)');
  const sec = (await db().ref(`loginSecrets/${ADMIN_UID}`).once('value')).val();
  ok(sec && sec.randomized === true && sec.salt && sec.hash && !JSON.stringify(sec).includes('Teach3rPass'), '비밀번호는 해시로만 저장되고 이전 완료 표시');
  const direct = async (email, password) => (await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: false }) })).ok;
  ok(!(await direct('admin@kst.com', 'Teach3rPass')), 'Firebase 주소를 직접 두드려도 이제 진짜 비밀번호로는 로그인 안 됨(무작위로 교체됨)');
  r = await A({ email: 'admin@kst.com', password: 'Teach3rPass' });
  ok(r.code === 200, '이전 뒤에도 서버를 통한 로그인은 정상');
  const tok = await admin.auth().verifyIdToken ? null : null; // (토큰 형식만 확인: 아래에서 사용자 uid 검증)
  const decoded = JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64').toString());
  ok(decoded.uid === ADMIN_UID, '발급된 토큰의 uid는 관리자 계정');
  r = await A({ email: 'master@kst.com', password: 'M@sterLongPassphrase99' });
  ok(r.code === 200 && JSON.parse(Buffer.from(r.body.token.split('.')[1], 'base64').toString()).uid === MASTER_UID, '마스터도 로그인(긴 비밀번호 가능: 23자)');
  r = await A({ email: 'ufes0002@kst.com', password: '4821' });
  ok(r.code === 401, '학생 계정은 관리자 로그인 경로로 들어올 수 없음');
  r = await A({ email: 'nobody@kst.com', password: 'x' });
  ok(r.code === 401, '없는 계정도 같은 401');
  r = await A({ email: 'not-an-email', password: 'x' });
  ok(r.code === 400, '형식이 틀리면 400');
  r = await A({ email: 'admin@kst.com', password: 'x'.repeat(200) });
  ok(r.code === 400, '너무 긴 비밀번호는 400');

  console.log('[7] 관리자 무차별 대입');
  h.advance(DAY);
  let evalA = 0, evalDay1 = 0; const t0 = h.now(); let crackedAdmin = false;
  for (let i = 0; i < 400 && h.now() - t0 < 7 * DAY; i++) {
    const rr = await A({ email: 'admin@kst.com', password: 'guess' + i }, newIp());
    if (rr.code === 200) { crackedAdmin = true; break; }
    if (rr.code === 401) { evalA++; if (h.now() - t0 < DAY) evalDay1++; }
    else if (rr.code === 429 && rr.body.lockedUntil) h.setNow(Math.max(h.now() + 1000, rr.body.lockedUntil + 1));
  }
  ok(!crackedAdmin && evalA <= 200, `IP를 계속 바꿔가며 7일 동안 대입해도 평가되는 횟수는 ${evalA}회(하루 약 ${evalDay1}회) — 긴 비밀번호면 사실상 불가능`);
  // 한 IP에서 서로 다른(없는) 계정으로 돌리는 스프레이: 실패 10번이면 차단
  h.advance(2 * H);
  let ipBlocked = 0; for (let i = 0; i < 14; i++) { const rr = await A({ email: `nobody${i}@kst.com`, password: 'bad' }, '8.8.8.8'); if (rr.code === 429 && rr.body.error === 'ip_limited') ipBlocked++; }
  ok(ipBlocked === 4, `한 IP의 관리자 로그인 실패가 시간당 10번을 넘으면 IP 차단(차단 ${ipBlocked}/14)`);
  r = await A({ email: 'master@kst.com', password: 'M@sterLongPassphrase99' }, '8.8.8.8');
  ok(r.code === 429, '그 IP에서는 맞는 비밀번호도 잠시 거절');
  r = await A({ email: 'master@kst.com', password: 'M@sterLongPassphrase99' }, '6.6.6.6');
  ok(r.code === 200, '다른 IP의 정상 로그인에는 영향 없음');

  console.log('[8] 옛 학생 계정(비밀번호 = "00"+PIN): 직접 대입 → 보호 이전');
  const PINS = ['4821', '0007', '5555'];
  for (let i = 0; i < PINS.length; i++) await mkStudent('ufes20' + i, PINS[i], 'legacy');
  await mkStudent('ufes209', '1234', 'legacy');
  await db().ref('students').child((await admin.auth().getUserByEmail('ufes209@kst.com')).uid).update({ phone: encryptOne(process.env.AES_KEY, '9999') }); // 저장된 PIN과 실제 비밀번호가 다른 계정
  ok(await direct('ufes200@kst.com', '004821'), '[이전 전] Firebase 주소를 직접 두드리면 "00"+PIN으로 로그인됨 → 대입 가능');
  h.setNow(h.realNow()); // 에뮬레이터가 발급하는 토큰은 실제 시각 기준이라 시뮬레이션 시계를 되돌린다
  const studentTok = await customToIdToken((await admin.auth().getUserByEmail('ufes0002@kst.com')).uid);
  const st0 = await call(adminApi, { action: 'legacy-auth-status' }, newIp(), { authorization: 'Bearer ' + studentTok });
  ok(st0.code === 403, '마스터가 아니면(학생 토큰) 이전 기능을 쓸 수 없음');
  const asMaster = async (body) => { const idt = await customToIdToken(MASTER_UID); return call(adminApi, body, newIp(), { authorization: 'Bearer ' + idt }); };
  async function customToIdToken(uid) { const ct = await admin.auth().createCustomToken(uid); const rr = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: ct, returnSecureToken: true }) }); return (await rr.json()).idToken; }
  let s1 = await asMaster({ action: 'legacy-auth-status' });
  ok(s1.code === 200 && s1.body.pending >= 4, `마스터: 이전 안 된 계정 수 확인(${JSON.stringify(s1.body)})`);
  let m = await asMaster({ action: 'legacy-auth-migrate' });
  ok(m.code === 200, '마스터: 이전 실행');
  const mm = m.body; ok(mm.migrated >= 3 && mm.mismatch.includes('ufes209'), `이전 ${mm.migrated}명, PIN 불일치 계정은 건드리지 않고 알려 줌: ${JSON.stringify({ migrated: mm.migrated, mismatch: mm.mismatch })}`);
  ok(!(await direct('ufes200@kst.com', '004821')), '[이전 후] 같은 직접 대입이 더 이상 통하지 않음');
  r = await call(login, { id: 'ufes200', pin: '4821', recaptchaToken: 't' }, newIp());
  ok(r.code === 200, '이전된 학생은 서버를 통해 정상 로그인');
  const rejSecret = (await db().ref('loginSecrets/' + (await admin.auth().getUserByEmail('ufes209@kst.com')).uid).once('value')).val();
  ok(!rejSecret, '불일치 계정은 아무것도 바꾸지 않음');
  const m2 = await asMaster({ action: 'legacy-auth-migrate', skip: mm.tried });
  ok(m2.code === 200 && m2.body.tried.every(x => !mm.tried.includes(x)), '이미 시도한 계정은 건너뛰고 다음 계정으로 진행(무한 반복 방지)');

  console.log('[9] 관리자 비밀번호 변경(마스터)');
  let acc = await asMaster({ action: 'admin-accounts' });
  ok(acc.code === 200 && acc.body.accounts.length === 2 && acc.body.accounts.every(x => x.serverPassword && x.randomized), '관리자 계정 목록(서버 비밀번호 설정 여부 표시): ' + JSON.stringify(acc.body.accounts.map(x => x.email)));
  ok(!JSON.stringify(acc.body).includes('hash') && !JSON.stringify(acc.body).includes('salt'), '해시·salt는 응답에 없음');
  for (const bad of ['short1', 'onlyletterslongenough', '1234567890123', 'x'.repeat(200)]) {
    const rr = await asMaster({ action: 'admin-password-set', uid: ADMIN_UID, password: bad });
    ok(rr.code === 400 && rr.body.error === 'weak_password', `약한 비밀번호 거부: ${bad.slice(0, 14)}…(${bad.length}자)`);
  }
  let rr = await asMaster({ action: 'admin-password-set', uid: 'ufes-student-uid', password: 'LongPassword123456' });
  ok(rr.code === 400 && rr.body.error === 'bad_uid', '관리자 계정이 아닌 uid는 거부');
  // 잠금이 걸린 상태에서 비밀번호를 바꾸면 잠금도 풀린다
  h.setNow(h.realNow());
  for (let i = 0; i < 3; i++) await A({ email: 'admin@kst.com', password: 'wrong' + i }, newIp());
  ok((await A({ email: 'admin@kst.com', password: 'Teach3rPass' })).code === 429, '3번 틀리면 관리자도 잠시 잠김');
  rr = await asMaster({ action: 'admin-password-set', uid: ADMIN_UID, password: 'Br4nd-New-Teacher-Passphrase' });
  ok(rr.code === 200, '마스터가 선생님 공용 계정 비밀번호를 긴 값으로 변경');
  ok((await A({ email: 'admin@kst.com', password: 'Br4nd-New-Teacher-Passphrase' })).code === 200, '새 비밀번호로 로그인(잠금도 풀림)');
  h.advance(2 * H);
  ok((await A({ email: 'admin@kst.com', password: 'Teach3rPass' })).code === 401, '예전 비밀번호는 더 이상 안 됨');
  ok(!(await direct('admin@kst.com', 'Br4nd-New-Teacher-Passphrase')), 'Firebase 주소를 직접 두드려도 새 비밀번호로 로그인 안 됨');

  console.log('[10] 관리자 잠금 해제(마스터 화면)');
  h.setNow(h.realNow());
  for (let i = 0; i < 3; i++) await A({ email: 'master@kst.com', password: 'wrong' + i }, newIp());
  ok((await A({ email: 'master@kst.com', password: 'M@sterLongPassphrase99' })).code === 429, '마스터 계정이 잠김');
  const locks = await asMaster({ action: 'locks' });
  const lk = locks.body.locks.find(l => l.id === 'admin:master@kst.com');
  ok(lk && lk.locked, '잠금 목록에 관리자 계정이 보임: ' + (lk && lk.id));
  rr = await asMaster({ action: 'unlock', id: 'admin:master@kst.com' });
  ok(rr.code === 200, '잠금 해제 요청 성공');
  ok((await A({ email: 'master@kst.com', password: 'M@sterLongPassphrase99' })).code === 200, '해제 뒤 바로 로그인');
  rr = await asMaster({ action: 'unlock', id: 'admin:../../students' });
  ok(rr.code === 400, '이상한 id는 거부');

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
