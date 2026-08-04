const fs = require('fs');
const path = require('path');
require('dotenv').config();

const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'kb-api-smoke-test.json');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

function redact(value) {
  if (!value) return value;
  const text = String(value);
  if (text.length <= 8) return '***';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
  return { text, body };
}

function tokenRequestBody(appKey, appSecret) {
  const format = String(process.env.KB_TOKEN_BODY_FORMAT || 'json').toLowerCase();
  const grantType = process.env.KB_GRANT_TYPE || 'client_credentials';

  if (format === 'form') {
    const body = new URLSearchParams();
    body.set(process.env.KB_GRANT_TYPE_FIELD || 'grant_type', grantType);
    body.set(process.env.KB_APP_KEY_FIELD || 'appkey', appKey);
    body.set(process.env.KB_APP_SECRET_FIELD || 'appsecret', appSecret);
    return {
      body: body.toString(),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  return {
    body: JSON.stringify({
      [process.env.KB_GRANT_TYPE_FIELD || 'grant_type']: grantType,
      [process.env.KB_APP_KEY_FIELD || 'appkey']: appKey,
      [process.env.KB_APP_SECRET_FIELD || 'appsecret']: appSecret,
    }),
    contentType: 'application/json',
  };
}

function findToken(body) {
  return body?.access_token
    || body?.accessToken
    || body?.token
    || body?.data?.access_token
    || body?.data?.accessToken
    || null;
}

async function main() {
  const result = {
    checkedAt: new Date().toISOString(),
    status: 'running',
    appKeyConfigured: Boolean(process.env.KB_APP_KEY),
    appSecretConfigured: Boolean(process.env.KB_APP_SECRET),
    tokenUrlConfigured: Boolean(process.env.KB_TOKEN_URL),
    quoteUrlConfigured: Boolean(process.env.KB_QUOTE_URL),
  };

  try {
    const appKey = required('KB_APP_KEY');
    const appSecret = required('KB_APP_SECRET');
    const tokenUrl = required('KB_TOKEN_URL');
    const request = tokenRequestBody(appKey, appSecret);

    const tokenResponse = await fetch(tokenUrl, {
      method: process.env.KB_TOKEN_METHOD || 'POST',
      headers: {
        'content-type': request.contentType,
        accept: 'application/json',
      },
      body: request.body,
      signal: AbortSignal.timeout(Number(process.env.KB_HTTP_TIMEOUT_MS || 30000)),
    });
    const tokenParsed = await parseResponse(tokenResponse);
    const accessToken = findToken(tokenParsed.body);

    Object.assign(result, {
      tokenHttpStatus: tokenResponse.status,
      tokenOk: tokenResponse.ok && Boolean(accessToken),
      tokenType: tokenParsed.body?.token_type || tokenParsed.body?.tokenType || null,
      expiresIn: tokenParsed.body?.expires_in || tokenParsed.body?.expiresIn || null,
      tokenPreview: redact(accessToken),
      tokenError: tokenResponse.ok ? null : tokenParsed.body,
    });

    if (!tokenResponse.ok || !accessToken) {
      throw new Error(`KB 접근토큰 발급 실패: HTTP ${tokenResponse.status}`);
    }

    const quoteUrl = String(process.env.KB_QUOTE_URL || '').trim();
    if (!quoteUrl) {
      result.status = 'token_completed_quote_skipped';
      writeResult(result);
      return;
    }

    const quoteHeaders = {
      accept: 'application/json',
      authorization: `${process.env.KB_AUTH_SCHEME || 'Bearer'} ${accessToken}`.trim(),
      [process.env.KB_APP_KEY_HEADER || 'appkey']: appKey,
      [process.env.KB_APP_SECRET_HEADER || 'appsecret']: appSecret,
    };
    if (process.env.KB_QUOTE_TR_ID) {
      quoteHeaders[process.env.KB_TR_ID_HEADER || 'tr_id'] = process.env.KB_QUOTE_TR_ID;
    }

    const quoteMethod = String(process.env.KB_QUOTE_METHOD || 'GET').toUpperCase();
    const quoteResponse = await fetch(quoteUrl, {
      method: quoteMethod,
      headers: quoteHeaders,
      body: quoteMethod === 'GET' ? undefined : (process.env.KB_QUOTE_BODY || undefined),
      signal: AbortSignal.timeout(Number(process.env.KB_HTTP_TIMEOUT_MS || 30000)),
    });
    const quoteParsed = await parseResponse(quoteResponse);

    Object.assign(result, {
      status: quoteResponse.ok ? 'completed' : 'quote_failed',
      quoteHttpStatus: quoteResponse.status,
      quoteOk: quoteResponse.ok,
      quoteResponseKeys: quoteParsed.body && typeof quoteParsed.body === 'object'
        ? Object.keys(quoteParsed.body).slice(0, 30)
        : [],
      quoteSample: quoteResponse.ok ? quoteParsed.body : null,
      quoteError: quoteResponse.ok ? null : quoteParsed.body,
    });
    writeResult(result);
    if (!quoteResponse.ok) process.exitCode = 2;
  } catch (error) {
    Object.assign(result, { status: 'failed', error: error.message });
    writeResult(result);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode ||= 1;
});
