// Publicacao no X com as credenciais DO CRIADOR (app dele, tokens dele).
// OAuth 1.0a assinado a mao com node:crypto, sem dependencia. Endpoint v2.
import crypto from 'node:crypto';

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauthHeader({ apiKey, apiSecret, accessToken, accessSecret }, method, url, extraParams = {}) {
  const params = {
    oauth_consumer_key: apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: '1.0',
    ...extraParams,
  };
  const base = [method.toUpperCase(), enc(url), enc(Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&'))].join('&');
  const signingKey = `${enc(apiSecret)}&${enc(accessSecret)}`;
  params.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  const head = Object.keys(params).filter((k) => k.startsWith('oauth_')).sort()
    .map((k) => `${enc(k)}="${enc(params[k])}"`).join(', ');
  return `OAuth ${head}`;
}

export async function postTweet(creds, text) {
  const url = 'https://api.x.com/2/tweets';
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: oauthHeader(creds, 'POST', url), 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.detail || body?.title || body?.errors?.[0]?.message || `X API ${res.status}`);
  return { id: body?.data?.id || null };
}

export const validCreds = (c) => !!(c && c.apiKey && c.apiSecret && c.accessToken && c.accessSecret);

// Telegram: bot do criador + id do canal/grupo. Bot API simples, sem assinatura.
export const validTelegram = (c) => !!(c && /^\d+:[A-Za-z0-9_-]{20,}$/.test(c.botToken || '') && /^-?\d+$|^@[A-Za-z0-9_]{5,}$/.test(c.chatId || ''));

export async function postTelegram({ botToken, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body?.description || `Telegram API ${res.status}`);
  return { id: body?.result?.message_id ?? null };
}
