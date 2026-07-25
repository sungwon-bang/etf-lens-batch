const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KRX_HOME_URL,
  LOGIN_LINK_SELECTOR,
} = require('../krx-auto-login');

test('KRX 메인 화면의 로그인 링크를 통해 로그인한다', () => {
  assert.equal(KRX_HOME_URL, 'https://data.krx.co.kr/');
  assert.equal(LOGIN_LINK_SELECTOR, 'a[href*="MDCCOMS001.cmd"]');
});
