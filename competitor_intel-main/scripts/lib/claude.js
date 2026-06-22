// Shared Claude API client for all fetchers
import Anthropic from '@anthropic-ai/sdk';

const { ANTHROPIC_API_KEY } = process.env;
if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY must be set');
  process.exit(1);
}

export const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Attempt to salvage a truncated JSON array by trimming to the last complete object.
function repairJson(text) {
  // Find the last complete closing brace before the truncation point
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace === -1) return null;
  const candidate = text.slice(0, lastBrace + 1);
  // Wrap array fragments back into the expected structure
  const arrayStart = candidate.indexOf('[');
  if (arrayStart === -1) return null;
  const repaired = candidate.slice(0, arrayStart) + candidate.slice(arrayStart) + ']}';
  try { return JSON.parse(repaired); } catch { return null; }
}

// Call Claude with a structured JSON output prompt.
// Returns parsed JSON or throws on failure.
export async function extractStructured(systemPrompt, userPrompt, { model = 'claude-haiku-4-5-20251001', maxTokens = 8192 } = {}) {
  const message = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content.find(b => b.type === 'text')?.text || '';

  // Strip markdown fences if present
  const text = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Try extracting the outermost JSON object/array
  const objMatch = text.match(/(\{[\s\S]*\})/);
  if (objMatch) {
    try { return JSON.parse(objMatch[1]); } catch (_) {}
  }

  // Last resort: repair truncated JSON
  const repaired = repairJson(text);
  if (repaired) {
    console.warn('  [claude] Response was truncated — salvaged partial JSON');
    return repaired;
  }

  throw new Error(`Claude JSON parse failed. stop_reason=${message.stop_reason}\nRaw: ${raw.slice(0, 400)}`);
}
