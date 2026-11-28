// 로컬 에뮬레이터(Auth + Realtime Database) 위에서 실제 서버 핸들러를 호출하는 테스트용 도구.
// 운영 키는 쓰지 않는다: 서비스 계정은 즉석에서 만든 가짜 키이고, 모든 호출은 127.0.0.1 에뮬레이터로만 간다.
const path = require('path');
const { generateKeyPairSync } = require('crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', project_id: 'demo-kst', private_key_id: 'x', private_key: privateKey, client_email: 'fake@demo-kst.iam.gserviceaccount.com', client_id: '1' });
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9199';
process.env.PIN_PEPPER = 'p'.repeat(40);
process.env.AES_KEY = 'k'.repeat(40);
process.env.NODE_PATH = path.join(__dirname, 'node_modules'); require('module').Module._initPaths();

// Firebase 로그인 REST 주소는 에뮬레이터로 돌린다(옛 계정을 확인하는 서버 코드가 이 주소를 부른다).
const realFetch = global.fetch;
global.fetch = (url, init) => realFetch(String(url).replace('https://identitytoolkit.googleapis.com/', 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/'), init);

// 시간 여행: 잠금(Date.now 기준)을 며칠 단위로 빠르게 시뮬레이션한다.
let clock = Date.now(); const realNow = Date.now;
Date.now = () => clock;

const BACKEND = process.env.BACKEND_DIR || path.join(__dirname, '..');
const admin = require(path.join(BACKEND, 'lib/firebaseAdmin')).admin;
function res() { const r = { headers: {}, code: 200, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; }
async function call(handler, body, ip = '1.1.1.1', headers = {}) {
  const r = res();
  await handler({ method: 'POST', body, headers: Object.assign({ 'x-forwarded-for': ip }, headers), query: {} }, r);
  return r;
}
module.exports = { admin, call, BACKEND, now: () => clock, setNow: (t) => { clock = t; }, advance: (ms) => { clock += ms; }, realNow, DAY: 86400000, H: 3600000 };
