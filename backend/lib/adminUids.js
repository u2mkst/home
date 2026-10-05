// Firebase 규칙·관리자 화면과 같은 UID 목록. 규칙(database.rules.json)의 UID와 항상 같이 바꿔야 한다.
const ADMIN_UIDS = new Set([
    "9temrm7WfSXRKo5v5jJiz65t8yF2", // admin@kst.com
    "OUcTOJNMDVXaMwouAqUluSvd2nH2", // 마스터
]);

// 마스터 전용 기능(api/admin.js)을 쓸 수 있는 UID. master.html의 MASTER_ALLOWED_UIDS, 규칙의 마스터 UID와 같아야 한다.
const MASTER_UIDS = new Set(["OUcTOJNMDVXaMwouAqUluSvd2nH2"]);

module.exports = { ADMIN_UIDS, MASTER_UIDS };
