'use strict';

// Gemini-powered contact insights and meeting briefs.
//
// Uses @google/genai (same SDK Gloss uses) — NOT @google/generative-ai.
// Inputs come from collected iMessage/Gmail/Calendar data plus Gloss profile
// pushes. Outputs are short, user-facing strings — insights are 2-3 sentence
// paragraphs, briefs are markdown with per-attendee headings.

const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-2.5-flash';

// ---------------------------------------------------------------------------
// System prompts (constraints shared across both generators)
// ---------------------------------------------------------------------------

const SHARED_RULES = `
You are a private assistant helping the user prep for interactions with people
in their life. You have access to a small, structured context per person:
communication cadence (counts, last-contact dates, email subject lines) and,
when available, a pointer-summary profile from the user's notebook app
("Gloss") — a growth note, priority, linked collections, and recent-context
entries describing why that person has appeared in the notebook.

Absolute rules you must follow:
1. NEVER invent, infer, or fabricate facts not present in the provided context.
   If something is not in the input, do not mention it.
2. NEVER quote anyone verbatim. The role_summary and recent_context entries
   are already pointer-summaries written by the notebook — refer to them and
   paraphrase, but do not copy them word-for-word.
3. If the context is sparse or empty, say so briefly. Do not pad with generic
   filler, platitudes, or invented backstory.
4. Output is for the user's private use. Be direct and practical. No flowery
   language, no hedging, no coaching-voice.
`.trim();

const INSIGHT_SYSTEM = `
${SHARED_RULES}

For this task you are generating a CONTACT INSIGHT:
- Output a single paragraph of 2-3 sentences. No headings, no bullets.
- Cover, in order: who this person is to the user (based on growth_note /
  linked_collections / recent_context), recent communication cadence (from
  message/email counts and last-contact dates), and one concrete thing the
  user might want to bring up next time — grounded in the growth_note or a
  recent_context entry.
- If there is no Gloss profile, lean on the cadence and email subjects only,
  and say plainly that there is no notebook context yet.
`.trim();

const BRIEF_SYSTEM = `
${SHARED_RULES}

For this task you are generating a MEETING BRIEF:
- Output markdown.
- Start with ONE short intro line naming the meeting and its purpose (from
  title + description + location). No heading on the intro line.
- Then one "## <Attendee Name>" section per attendee, in the order provided.
- Under each attendee, write 2-3 bullet points: who they are to the user,
  recent context (cadence + notebook), and 1-2 suggested talking points.
- Keep each attendee section scannable — roughly 200 tokens or less.
- If NO attendee has Gloss profile data, skip the per-attendee sections and
  instead output a single line noting that no prep context is available and
  this looks like a general meeting.
`.trim();

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not set');
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

async function callGemini(systemInstruction, userPrompt, { temperature = 0.4 } = {}) {
  const ai = getClient();
  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: { systemInstruction, temperature },
    });
    const text = (result.text || '').trim();
    if (!text) throw new Error('Gemini returned empty response');
    return text;
  } catch (err) {
    throw new Error(`Gemini call failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Context formatting — kept as a plain JSON block so the model sees exactly
// what we have and nothing more. Never pass raw message text.
// ---------------------------------------------------------------------------

function formatRecentComms(rc) {
  if (!rc) return null;
  return {
    message_count_30d:     rc.message_count_30d ?? 0,
    email_count_30d:       rc.email_count_30d ?? 0,
    last_message_date:     rc.last_message_date || null,
    last_email_date:       rc.last_email_date || null,
    recent_email_subjects: Array.isArray(rc.recent_email_subjects)
      ? rc.recent_email_subjects.slice(0, 10)
      : [],
  };
}

function formatGlossProfile(p) {
  if (!p) return null;
  return {
    growth_note:       p.growth_note || null,
    priority:          p.priority ?? null,
    mention_count:     p.mention_count ?? 0,
    last_mentioned_at: p.last_mentioned_at || null,
    linked_collections: Array.isArray(p.linked_collections) ? p.linked_collections : [],
    recent_context:    Array.isArray(p.recent_context)
      ? p.recent_context.slice(0, 8).map(c => ({
          date:         c.date || null,
          collection:   c.collection || null,
          role_summary: c.role_summary || null,
        }))
      : [],
  };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

async function generateContactInsight({ contact, glossProfile, recentComms }) {
  const payload = {
    contact,
    gloss_profile: formatGlossProfile(glossProfile),
    recent_comms:  formatRecentComms(recentComms),
  };

  const prompt = [
    `Contact: ${contact}`,
    '',
    'Context (JSON):',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'Write a 2-3 sentence insight paragraph per the rules in the system prompt.',
  ].join('\n');

  return callGemini(INSIGHT_SYSTEM, prompt);
}

async function generateMeetingBrief({ event, attendeeProfiles }) {
  const evt = {
    title:       event?.title || '(untitled)',
    start_time:  event?.start_time || null,
    location:    event?.location || null,
    description: truncate(event?.description || '', 200),
  };

  const attendees = (attendeeProfiles || []).map(a => ({
    contact:       a.contact,
    gloss_profile: formatGlossProfile(a.glossProfile),
    recent_comms:  formatRecentComms(a.recentComms),
  }));

  const anyGloss = attendees.some(a => a.gloss_profile);

  const prompt = [
    'Event:',
    '```json',
    JSON.stringify(evt, null, 2),
    '```',
    '',
    `Attendees (${attendees.length}):`,
    '```json',
    JSON.stringify(attendees, null, 2),
    '```',
    '',
    anyGloss
      ? 'Write the meeting brief per the rules in the system prompt.'
      : 'No attendees have Gloss profile data. Output the short "no prep context available — general meeting" note per the system prompt.',
  ].join('\n');

  return callGemini(BRIEF_SYSTEM, prompt);
}

module.exports = {
  generateContactInsight,
  generateMeetingBrief,
  // Exported for testing / introspection
  INSIGHT_SYSTEM,
  BRIEF_SYSTEM,
};
