/**
 * Summarize a long Claude Code output into a short 1-2 sentence whisper
 * that makes sense as TTS audio in the user's ear.
 *
 * We intentionally keep this small — no streaming, no tool use, no history.
 * Just: long output in → short summary out.
 */

const SUMMARY_MODEL = process.env.CLAUDE_SUMMARY_MODEL || 'claude-haiku-4-5';
const SUMMARY_TIMEOUT_MS = 8000;

export async function synthesizeCodeSummary(
  apiKey: string,
  language: string,
  rawOutput: string,
  taskPrompt: string
): Promise<string | null> {
  if (!apiKey || !rawOutput || rawOutput.length < 20) return null;

  // Truncate to keep cost bounded; the model sees the most relevant parts
  const truncated = rawOutput.length > 4000 ? rawOutput.slice(0, 3000) + '\n...[truncated]\n' + rawOutput.slice(-1000) : rawOutput;

  const systemPrompt = `You are Angel, summarizing Claude Code's execution results into a short whisper (1-2 sentences, max 40 words) that will be spoken aloud to the user via TTS.

Rules:
- Respond in ${language} ONLY.
- Lead with the concrete outcome (what was built/fixed/found), not "Claude Code did X".
- Be specific: name files/actions. "Created LoginForm.tsx with email/password fields" beats "completed the task".
- If the task failed, say what went wrong in one sentence.
- No filler words. No "the output shows that..." or "I can see that...".
- Plain text only. No JSON, no markdown.`;

  const userMessage = `Task given to Claude Code:\n"${taskPrompt.slice(0, 400)}"\n\nClaude Code's output:\n${truncated}\n\nSummarize for the user's ear:`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        max_tokens: 150,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error(`[summarizer] API ${response.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data?.content || []).find((b) => b.type === 'text')?.text;
    return text ? text.trim().slice(0, 500) : null;
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name !== 'AbortError') console.error('[summarizer] failed:', err?.message);
    return null;
  }
}
