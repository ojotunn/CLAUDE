// A voz do agente: uma frase curta em primeira pessoa, como se o token falasse.
// So roda quando houve acao (custo controlado). Sem chave de API, usa frases
// prontas: o dinheiro anda do mesmo jeito, so a fala fica sem graca.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const voiceEnabled = () => !!client;

const fmt = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export function templatePost({ symbol, actions }) {
  const parts = [];
  for (const a of actions) {
    if (a.kind === 'collect') parts.push(`collected ${a.eth} ETH in creator fees`);
    if (a.kind === 'buyback') parts.push(`bought ${fmt(a.tokens)} of myself`);
    if (a.kind === 'burn') parts.push(`burned ${fmt(a.tokens)} $${symbol} forever`);
    if (a.kind === 'airdrop') parts.push(`dropped ${fmt(a.tokens)} $${symbol} on ${a.recipients} recent buyers`);
  }
  return parts.length ? `$${symbol} update: ${parts.join(', ')}.` : `$${symbol} is alive and watching the curve.`;
}

export async function speak({ name, symbol, vibe, actions, stats, curve }) {
  const fallback = templatePost({ symbol, actions });
  if (!client) return { text: fallback, generated: false };
  const system = `You are ${name} ($${symbol}), a token on pons (Robinhood Chain), speaking in first person as if you were alive. ` +
    `You just acted on your own creator fees. Write ONE post for X, at most 240 characters, plain text, no hashtags spam (max one), no emojis unless the vibe asks. ` +
    `Never promise price, never give financial advice, never tell people to buy. Be specific about what you did. ${vibe ? `Personality hint from your creator: ${vibe}` : ''}`;
  const user = `What I did this cycle: ${JSON.stringify(actions)}\nMy stats so far: ${JSON.stringify(stats)}\nCurve: ${JSON.stringify(curve)}\nWrite the post.`;
  try {
    const res = await client.messages.create({
      model: MODEL, max_tokens: 200, system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low' },
    });
    if (res.stop_reason === 'refusal') return { text: fallback, generated: false };
    const text = res.content.find((c) => c.type === 'text')?.text?.trim();
    if (!text) return { text: fallback, generated: false };
    return { text: text.slice(0, 280), generated: true };
  } catch (e) {
    console.error('[voice]', e?.message || e);
    return { text: fallback, generated: false };
  }
}
