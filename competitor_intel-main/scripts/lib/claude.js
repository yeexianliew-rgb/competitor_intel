// Shared Claude API client for all fetchers
import Anthropic from '@anthropic-ai/sdk';

const { ANTHROPIC_API_KEY } = process.env;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY must be set');
  process.exit(1);
}

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Call Claude with a structured JSON output prompt.
// Returns parsed JSON or throws on failure.
export async function extractStructured(systemPrompt, userPrompt, { model = 'claude-sonnet-4-6', maxTokens = 4096 } = {}) {
  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const text = message.content.find(b => b.type === 'text')?.text || '';

  // Extract JSON from the response (handles markdown fences)
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!jsonMatch) throw new Error(`Claude returned no JSON. Response: ${text.slice(0, 300)}`);

  try {
    return JSON.parse(jsonMatch[1] || jsonMatch[0]);
  } catch (e) {
    throw new Error(`Claude JSON parse failed: ${e.message}\nRaw: ${text.slice(0, 500)}`);
  }
}
