// Generates a contextual draft reply using the Anthropic API, instead of a
// fixed static template. Only used for categories where the user explicitly
// turns on "AI-written reply." Requires ANTHROPIC_API_KEY — if it's not set,
// isConfigured() returns false and callers should fall back to the static
// template (handled in server.js).

let Anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
} catch (e) {
  // Package not installed yet (e.g. before `npm install`); isConfigured()
  // below will still correctly report unavailable.
}

function isConfigured() {
  return !!(Anthropic && process.env.ANTHROPIC_API_KEY);
}

async function generateReply({ subject, from, bodyText, instructions }) {
  if (!isConfigured()) {
    throw new Error('ANTHROPIC_API_KEY is not set — AI replies are unavailable.');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  // Keep the email content bounded — we only need enough for a sensible
  // reply, not the whole thread history.
  const trimmedBody = (bodyText || '').slice(0, 4000);

  const prompt = `You are drafting a short email reply on behalf of the inbox owner. Write ONLY the reply body text — no subject line, no "Here's a draft" preamble, no explanation. Keep it brief and natural, like a real person wrote it quickly.

Guidance for this category of email: ${instructions || 'Write a brief, polite, helpful reply.'}

The email you're replying to:
From: ${from || '(unknown)'}
Subject: ${subject || '(no subject)'}
Body:
${trimmedBody || '(no body content available)'}

Write the reply now.`;

  const res = await client.messages.create({
    model,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = (res.content || [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('AI reply came back empty.');
  return text;
}

module.exports = { generateReply, isConfigured };
