# K&P 수학입시학원 with KST

KST(K&P System for Teaching)는 K&P 수학입시학원에서 사용하는 학생·강사·관리자용 웹 시스템입니다. 정적 HTML/CSS/JavaScript를 기반으로 GitHub Pages에서 제공하며, Firebase와 Vercel 서버리스 API, 별도 Android 키오스크 앱과 연동됩니다.

> **배포 주소:** [KST HUB](https://u2mkst.github.io/home/)  
> **저장소:** [u2mkst/home](https://github.com/u2mkst/home)  
> **Android 앱 저장소:** [u2mkst/app](https://github.com/u2mkst/app)

---

## 목차

- [서비스 구성](#서비스-구성)
- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [저장소 구조](#저장소-구조)
- [디자인 시스템](#디자인-시스템)
- [백엔드 API](#백엔드-api)
- [Android 키오스크 앱](#android-키오스크-앱)
- [배포 및 릴리스](#배포-및-릴리스)
- [보안 및 개발 유의사항](#보안-및-개발-유의사항)

## 서비스 구성

| 파일 | 역할 | 접근 대상 |
|---|---|---|
| `login.html` | 로그인 및 계정 인증 진입점 | 학생·사용자 |
| `index.html` | 학생용 메인 앱: 홈, 마이페이지, 랭킹 등 | 로그인 학생 |
| `admin.html` | 학생 관리, 공지 및 메시지 등 운영 기능 | 강사·직원 |
| `master.html` | 시스템 설정 및 학교명 오버라이드 관리 | 허용된 최상위 관리자 |
| `kst.html` | KST 시스템 관리 진입점 및 Android 앱 다운로드 | 허용된 관리자 |
| `kst.apk` | 키오스크용 Android WebView 앱 설치 파일 | 학원 태블릿 |

## 주요 기능

### 학생 앱 — `index.html`
- Firebase Authentication 로그인 및 U2M 계정 연동
- 출석 체크와 월별 누적 출석 기록
- NEIS 및 컴시간 데이터를 이용한 학교 시간표 조회
- NEIS 학사일정 기반 수능 D-Day 표시
- 학년별 오늘의 문제 및 마우스·터치·스타일러스용 풀이 패드
- 로또 번호 예측 게임과 적중 기록
- 누적 출석·문제 풀이·게임 기록에 따른 업적 배지와 랭킹
- 선생님 공지 및 실시간 메시지 수신
- 사용자 계정에 저장되는 다크 모드

### 관리자 — `admin.html`
학생 정보 관리, 공지·메시지 발송 등 학원 운영 기능을 제공합니다.

### 최상위 관리자 — `master.html`
허용된 이메일을 기준으로 접근을 제한하며, NEIS 학교명과 컴시간 학교명이 일치하지 않을 때 학교별 이름 오버라이드를 관리할 수 있습니다.

## 기술 스택

| 영역 | 사용 기술 |
|---|---|
| 프론트엔드 | HTML, CSS, JavaScript — 별도 빌드 도구 없이 동작 |
| 인증 및 데이터 | Firebase Authentication, Firebase Realtime Database |
| 서버 API | Vercel Serverless Functions, Node.js |
| 학교 정보 | NEIS Open API, 컴시간 API |
| Android 앱 | Kotlin, Gradle, Android WebView — 별도 저장소 |
| 배포 자동화 | GitHub Pages, GitHub Actions, Vercel |

## 저장소 구조

```text
.
├── login.html              # 로그인
├── index.html              # 학생용 메인 앱
├── admin.html              # 강사·직원 관리자
├── master.html             # 최상위 관리자
├── kst.html                # 시스템 관리 및 APK 다운로드
├── kst.apk                 # 자동 배포되는 Android 앱
├── VERSION                 # 웹 릴리스 버전
├── css/
│   ├── tokens.css          # 공통 색상·간격·모서리·그림자 토큰
│   └── components.css      # 공통 UI 및 버튼 규칙
├── backend/
│   ├── api/
│   │   ├── neis.js         # NEIS API 프록시
│   │   ├── comcigan.js     # 컴시간 시간표 API 프록시
│   │   ├── encrypt.js      # 인증 기반 AES 암호화
│   │   └── decrypt.js      # 인증 기반 AES 복호화
│   ├── lib/
│   │   ├── aes.js
│   │   ├── cors.js
│   │   └── firebaseAdmin.js
│   ├── .env.example
│   └── vercel.json
└── .github/
    └── workflows/
        └── release.yml     # 웹 릴리스 자동 생성
```

## 디자인 시스템

공통 디자인 규칙은 `css/` 아래에서 관리합니다. 페이지마다 기존 고유 스타일이 남아 있으므로, 새 스타일을 추가할 때는 공통 규칙을 먼저 확인하고 기존 기능·테마를 덮어쓰지 않도록 합니다.

### 공통 CSS

| 파일 | 담당 내용 |
|---|---|
| `css/tokens.css` | KST 파랑, 텍스트·배경·테두리 색상, 모서리, 그림자, 포커스 링 등 디자인 변수 |
| `css/components.css` | 공통 버튼 계층, 상태별 색상, 상호작용 및 일부 기존 버튼 클래스 보정 |

현재 주요 페이지(`login.html`, `index.html`, `admin.html`, `master.html`)에서 두 파일을 불러옵니다.

### 버튼 규칙

| 유형 | 클래스 | 용도 | 기본 스타일 |
|---|---|---|---|
| 기본 | `kst-btn kst-btn-primary` | 저장, 확인, 계속, 실행 | 파란색 배경 |
| 보조 | `kst-btn kst-btn-secondary` | 취소, 닫기, 뒤로 | 흰색 배경과 회색 테두리 |
| 위험 | `kst-btn kst-btn-danger` | 삭제, 제거 등 되돌리기 어려운 동작 | 연한 빨강, 빨간 테두리 |
| 최소 강조 | `kst-btn kst-btn-ghost` | 보조 링크나 가벼운 동작 | 투명 배경, 파란색 글자 |

예시:

```html
<button class="kst-btn kst-btn-primary">저장</button>
<button class="kst-btn kst-btn-secondary">취소</button>
<button class="kst-btn kst-btn-danger">삭제</button>
<button class="kst-btn kst-btn-ghost">자세히 보기</button>
```

**버튼 적용 원칙**
- 주요 완료 동작은 파란색, 취소·보조 동작은 흰색 테두리, 삭제·제거는 빨간색으로 구분합니다.
- 버튼의 색상은 실제 기능의 의미를 따라야 합니다. 단순히 눈에 띄게 하려고 삭제 버튼을 파란색으로 만들지 않습니다.
- 비활성 버튼은 `disabled` 속성을 사용하고, 키보드 포커스가 보이도록 유지합니다.
- 페이지별 기존 클래스는 한 번에 전부 바꾸지 말고, 기능을 확인하면서 단계적으로 공통 클래스로 전환합니다.

### 테마와 수정 시 주의점
- 학생 페이지는 `data-theme="dark"` 기반 다크 모드 동작을 유지해야 합니다.
- 페이지에서 이미 제공하는 CSS 변수를 우선 사용하고, 테마가 바뀌어도 유지되어야 하는 요소에 색상을 하드코딩하지 않습니다.
- 새 공통 규칙은 기존 페이지의 고유 레이아웃이나 컴포넌트 상태를 무조건 덮어쓰지 않도록 범위를 좁혀 작성합니다.
- CSS 변경 후 PC·모바일, 라이트·다크 모드, hover·focus·disabled 상태를 각각 확인합니다.

## 백엔드 API

`backend/`는 프론트엔드에 민감 키를 노출하지 않고 학교 정보 조회 및 암복호화를 처리하기 위한 Vercel 서버리스 함수입니다.

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/neis` | GET | NEIS 학교 정보·학사일정·시간표 API 프록시 |
| `/api/comcigan` | GET | 컴시간 시간표 프록시 및 학교명 자동 재시도 |
| `/api/encrypt` | POST | Firebase 인증 토큰을 확인한 뒤 AES 암호화 |
| `/api/decrypt` | POST | Firebase 인증 토큰을 확인한 뒤 AES 복호화 |

Vercel 프로젝트 환경 변수는 `.env.example`을 기준으로 설정합니다.

- `AES_KEY`: 기존 저장 데이터와 호환되어야 하는 암호화 키
- `NEIS_API_KEY`: NEIS Open API 키
- `FIREBASE_SERVICE_ACCOUNT`: Firebase 서비스 계정 JSON
- `ALLOWED_ORIGIN`: CORS 허용 출처(예: `https://u2mkst.github.io`)

실제 키나 서비스 계정 정보를 README, 코드 또는 커밋에 입력하지 마세요.

## Android 키오스크 앱

Android 앱은 별도 저장소 [`u2mkst/app`](https://github.com/u2mkst/app)에서 관리합니다. 패키지명은 `com.u2m.kp`이며, WebView로 웹 시스템을 표시합니다.

앱 저장소의 `main` 브랜치에 push하면 GitHub Actions가 릴리스용 APK를 빌드하고, 앱 저장소에 릴리스를 생성한 뒤 이 저장소의 `kst.apk`를 갱신하도록 구성되어 있습니다. 서명용 keystore는 GitHub Secrets로만 관리해야 합니다.

## 배포 및 릴리스

### 웹
- GitHub Pages는 이 저장소의 `main` 브랜치를 정적 사이트로 배포합니다.
- 개발 작업은 별도 브랜치에서 진행하고, 검토 후 PR을 통해 `main`에 반영합니다.
- 개발 브랜치의 변경은 `main`에 반영되기 전까지 공개 사이트에 자동 적용되지 않습니다.

### 백엔드
- `backend/`는 Vercel 프로젝트와 연결되어 별도로 배포됩니다.
- 필요한 환경 변수는 Vercel 프로젝트 설정에서 관리합니다.

### 버전
- 루트의 `VERSION` 파일에 웹 릴리스 버전을 기록합니다.
- `.github/workflows/release.yml`은 `main`에 push될 때 해당 버전을 읽어 GitHub Release를 생성하거나 갱신합니다.
- 릴리스 내역은 [GitHub Releases](https://github.com/u2mkst/home/releases)에서 확인할 수 있습니다.

## 보안 및 개발 유의사항

- API 키, AES 키, Firebase 서비스 계정, Android 서명 키 등 민감 정보는 저장소에 커밋하지 않습니다.
- 인증·데이터베이스 규칙을 변경할 때는 학생·강사·최상위 관리자 권한을 각각 확인합니다.
- CSS 작업이라도 로그인, 모달, 로딩 화면, 반응형 레이아웃 및 다크 모드에 영향을 줄 수 있으므로 변경 후 주요 흐름을 점검합니다.
- 배포 전에는 변경 파일과 PR diff를 확인하고, 실제 브라우저에서 PC와 모바일 화면을 검증합니다.
