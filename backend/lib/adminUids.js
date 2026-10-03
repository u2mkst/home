// Firebase 규칙·관리자 화면과 같은 UID 목록. 규칙(database.rules.json)의 UID와 항상 같이 바꿔야 한다.
const ADMIN_UIDS = new Set([
    "9temrm7WfSXRKo5v5jJiz65t8yF2", // admin@kst.com
    "OUcTOJNMDVXaMwouAqUluSvd2nH2", // 마스터
]);

module.exports = { ADMIN_UIDS };
