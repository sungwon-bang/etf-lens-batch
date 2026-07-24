const test = require('node:test');
const assert = require('node:assert/strict');

const { LOGIN_URL } = require('../krx-auto-login');

test('로그인 전용 URL을 직접 사용한다', () => {
  assert.equal(
    LOGIN_URL,
    'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd',
  );
});
