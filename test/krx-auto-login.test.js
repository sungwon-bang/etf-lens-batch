const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KRX_HOME_URL,
  LOGIN_LINK_SELECTOR,
  loginContext,
  WINDOWS_CHROME_USER_AGENT,
} = require('../krx-auto-login');

test('KRX 메인 화면의 로그인 링크를 통해 로그인한다', () => {
  assert.equal(KRX_HOME_URL, 'https://data.krx.co.kr/');
  assert.equal(LOGIN_LINK_SELECTOR, 'a[href*="MDCCOMS001.cmd"]');
});

test('수집 컨텍스트에서 직접 로그인할 수 있다', () => {
  assert.equal(typeof loginContext, 'function');
  assert.match(WINDOWS_CHROME_USER_AGENT, /Windows NT 10\.0/);
  assert.doesNotMatch(WINDOWS_CHROME_USER_AGENT, /HeadlessChrome/);
});
