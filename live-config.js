/*
 * live-config.js — (선택) 내 Supabase 공개 정보
 * Copyright 2026 엘레나
 *
 * 비워 두면: 선생님 화면의 ⚙ 설정에 넣은 값을 씁니다(그 컴퓨터에만 기억).
 * 채워 두면: 어느 컴퓨터에서 열어도 바로 연결되고, 학생이 QR 없이
 *            주소#s 로 들어와 6자리 코드만 쳐도 입장할 수 있어요.
 *
 * ⚠ 여기에는 "공개 키"(anon 또는 sb_publishable_…)만 넣으세요.
 *    비밀 키(service_role, sb_secret_…)는 절대 넣지 마세요. 엔진이 거부합니다.
 */
window.LIVE_CONFIG = {
  url: '',   // 예: 'https://abcdefghijklmnop.supabase.co'
  key: ''    // 예: 'sb_publishable_...' 또는 'eyJhbGciOi...'(anon)
};
