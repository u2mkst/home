# KST Backend

Vercel 서버리스 함수. AES 키·NEIS 키·Firebase 관리자 권한처럼 브라우저에 두면 안 되는 것들을 맡는다.

## API

| 경로 | 인증 | 설명 |
|---|---|---|
| `POST /api/student-login` | 없음(reCAPTCHA·락아웃·IP 한도) | 아이디+PIN을 서버가 검증하고 Firebase 커스텀 토큰 발급 |
| `POST /api/register` | 없음(reCAPTCHA·IP 한도) | 학생 가입(계정 생성·암호화·DB 기록을 서버가 수행) |
| `POST /api/account` | ID 토큰 | `set-pin`(로그인 PIN 변경) / `delete`(PIN 확인 후 회원 탈퇴, 관련 기록 전부 삭제) |
| `POST /api/admin` | ID 토큰(마스터 UID만) | 마스터 운영 도구: `locks`/`unlock`, `reset-pin`, `students`, `set-disabled`, `delete-student`, `attendance-get`/`attendance-set`, `status`, `lotto-resync`/`lotto-set-draw`/`lotto-clear-predictions` |
| `POST /api/attendance` | ID 토큰 | 서버 시각 기준 오늘 출석 기록 + 랭킹용 횟수 + 출석 업적 |
| `POST /api/lotto` | ID 토큰 | `status`(당첨번호·회차·접수 가능 여부) / `submit`(예측 제출) |
| `GET /api/lotto` | `CRON_SECRET` | Vercel 크론: 추첨 직후 당첨번호 저장 + 예측 판정 + 로또 업적 지급 |
| `POST /api/encrypt`, `/api/decrypt` | ID 토큰 | AES 암복호화(복호화는 본인/검증된 이름/관리자만) |
| `GET /api/neis`, `/api/comcigan`, `/api/weather` | 없음 | 외부 API 프록시 |
| `GET /api/health` | 없음(상세는 마스터 토큰) | 익명이면 `{ok:true}`만. 마스터 ID 토큰을 보내면 필수 환경변수 설정 여부를 true/false로 보여줌(값은 노출 안 함) |

## 학생 인증 구조

학생의 Firebase 비밀번호는 **무작위 값**이다. PIN(4자리)은 `loginSecrets/{uid}`에 `scrypt(salt + PIN_PEPPER)` 해시로만 저장하고
(클라이언트 접근 불가), 검증은 `/api/student-login`만 한다. 그래서 Firebase REST API를 직접 두드려도 PIN을 대입할 수 없다.
기존 계정은 첫 로그인 때 자동 이전되고, `scripts/migrate-student-auth.js`로 한꺼번에 이전할 수도 있다.

## 로또

- 1회차 추첨일(2002-12-07 토 20:35 KST)로부터 매주 한 회차. 서버가 "지금 끝났어야 할 회차"를 계산한다.
- 추첨 15분 뒤부터 첫 요청(또는 토요일 21:00 KST 크론)이 외부 API에서 당첨번호를 받아 `lottoDraws/{회차}`에 저장하고 판정한다.
- 접수는 추첨 10분 전에 마감(서버 시각 기준). 학생은 `lotto_predictions`/`lottoDraws`에 직접 쓸 수 없다.

## 스크립트(`scripts/`)

- `backfill-public-students.js`: 랭킹용 공개 노드 채우기(일회성)
- `migrate-student-auth.js`: 기존 학생 계정을 서버 PIN 검증 방식으로 이전(미리보기 → `--apply`)

환경변수 목록은 `.env.example` 참고.

> ⚠️ Vercel 무료(Hobby) 플랜은 `api/` 안의 서버 함수를 **12개까지만** 배포할 수 있다. 새 API는 기존 파일에 `action`으로 묶는 걸 우선 고려할 것.


## U2M 월간 보고서 연동 — 현재 상태

### 구현되어 있는 부분
- `lib/u2mReportParser.js`: U2M 보고서 HTML 문자열을 파싱하는 순수 함수 모듈.
- `lib/u2mReportParser.test.js`: 외부 네트워크나 실제 계정 없이 실행하는 파서 단위 테스트.
- 파서는 `.card_wrap`, `.sep`, `.card_tit .tit`, `.achv_level .num`, `.com_level .num` 구조를 사용해 과정명, 기간, 성취도, 이수도를 추출한다.
- 로그인 HTML, 잘못된 입력, 구조 변경, 비어 있는 월, 누락된 필드 등을 구분한다.

테스트 실행:
```sh
node backend/lib/u2mReportParser.test.js
```

### 아직 구현되지 않은 부분
- `study.u2math.co.kr`에서 보고서 HTML을 가져오는 서버 측 인증/세션 처리
- 인증된 K&P 사용자와 본인 U2M 계정의 안전한 연결
- U2M 보고서를 조회·캐시하는 API 및 화면 연결
- 자동 갱신/Cron

### 인증 검증 메모
사용자가 직접 U2M 학습 사이트에 로그인한 브라우저에서
`fetch('/Report/List?year=2026&month=10')`를 실행했을 때 HTML을 가져오고,
위 선택자로 보고서 데이터를 파싱하는 것까지 확인했다. 이는 해당 브라우저의 로그인 세션에서 성공했다는 뜻일 뿐,
Vercel 서버에서도 인증이 가능하다는 증거는 아니다.

U2M 사이트 이동 중 `/Mypage/goSite` POST(`site=study`)와
`/User/Login?info=...` 형식의 인증 전달 URL이 관찰되었으나, 토큰의 의미·수명·재사용성·정식 연동 허용 여부는 확인되지 않았다.
인증 전달 URL, 쿠키, 비밀번호, 토큰을 코드에 하드코딩하거나 로그에 남기지 말 것.
브라우저 쿠키를 서버로 복사하거나 인증 보호를 우회하지 말 것.

### 구현 원칙
1. 서버 API는 Firebase ID 토큰을 검증하고 요청한 사용자의 UID를 서버에서 확정한다.
2. 클라이언트가 임의 UID를 지정해 다른 학생의 데이터를 읽거나 저장할 수 없도록 한다.
3. U2M의 허가된 인증 경로가 확인되기 전에는 실제 보고서 수집 API를 성공하는 것처럼 만들지 않는다.
4. HTML 파싱과 외부 인증/네트워크 호출을 분리한다.
5. 인증이 불가능하거나 세션이 만료된 경우 `login_required` 등 명시적 오류를 반환한다.
6. 보고서 데이터는 사용자 UID 및 연월별로 분리하고, 인증 정보는 로그와 응답에서 제외한다.

### 다음 구현 단계
- U2M이 허용하는 API/서버 연동 방식 또는 공식 계정 연결 방법 확인
- 인증 검증 결과를 바탕으로 별도 `/api/u2m-report` 엔드포인트 설계
- 파서 테스트 통과 후 테스트 환경에서 인증 및 보고서 수집을 검증
- 마지막으로 K&P UI에 월 선택, 과정 카드, 성취도/이수도, 마지막 갱신 시간을 추가

이 문서는 인증이 검증되었다고 주장하지 않는다. 실제 자동 수집을 구현하기 전에 남은 기술적·권한상 조건을 명확히 기록한다.
