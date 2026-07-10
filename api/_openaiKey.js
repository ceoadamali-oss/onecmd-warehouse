/** OpenAI API key — OPENAI_API_KEY preferred; VITE_OPENAI_API_KEY fallback for Vercel env parity. */
export function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
}
