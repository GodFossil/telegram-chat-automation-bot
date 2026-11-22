export async function generateReply({ baseUrl, key, model, persona, history }) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);
  if (url.protocol !== 'https:') throw new Error('LLM_BASE_URL must use HTTPS');
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [
      { role: 'system', content: persona },
      { role: 'user', content: `Telegram conversation transcript (JSON):\n${JSON.stringify(history)}` },
    ] }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
  const text = (await response.json()).choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty LLM reply');
  return text.trim().slice(0, 2000);
}
