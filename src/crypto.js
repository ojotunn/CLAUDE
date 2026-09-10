// Segredos em repouso (chave da carteira do agente, credenciais do X) ficam
// cifrados com AES-256-GCM usando AGENT_SECRET. Sem AGENT_SECRET o modulo de
// agentes nem liga. Sessoes do criador sao HMAC assinados com o mesmo segredo.
import crypto from 'node:crypto';

const SECRET = process.env.AGENT_SECRET || '';
export const agentsEnabled = () => SECRET.length >= 16;

const key = () => crypto.createHash('sha256').update(SECRET).digest();

export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function open(sealed) {
  const [v, iv, tag, enc] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown sealed format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// Sessao do criador: "wallet|token|expira" assinado. Vale 24h.
export function issueSession({ wallet, token }) {
  const exp = Date.now() + 24 * 3600 * 1000;
  const body = `${wallet.toLowerCase()}|${token.toLowerCase()}|${exp}`;
  const mac = crypto.createHmac('sha256', key()).update(body).digest('base64url');
  return Buffer.from(body).toString('base64url') + '.' + mac;
}

export function readSession(session) {
  try {
    const [b, mac] = String(session || '').split('.');
    const body = Buffer.from(b, 'base64url').toString('utf8');
    const expect = crypto.createHmac('sha256', key()).update(body).digest('base64url');
    if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    const [wallet, token, exp] = body.split('|');
    if (Number(exp) < Date.now()) return null;
    return { wallet, token };
  } catch { return null; }
}
