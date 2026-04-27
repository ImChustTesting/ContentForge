import Anthropic from '@anthropic-ai/sdk';

export const HAIKU_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

export async function testAnthropicKey(apiKey) {
  const client = new Anthropic({ apiKey });
  try {
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say "ok".' }]
    });
    const text = resp.content?.find?.((b) => b.type === 'text')?.text ?? '';
    return { ok: true, text };
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    const message = err?.message ?? String(err);
    return { ok: false, status, message };
  }
}
