'use strict';

// Gemini-powered contact insights and meeting briefs.
//
// Uses @google/genai (same SDK Gloss uses) — NOT @google/generative-ai.
// Inputs come from collected iMessage/Gmail/Calendar data plus Gloss profile
// pushes. Outputs are short, user-facing strings — insights are 2-3 sentence
// paragraphs, briefs are markdown with per-attendee headings.

const { GoogleGenAI } = require('@google/genai');

const MODEL = 'gemini-2.5-flash';

// C-I-01: Contact-insight model selection (Gemini-only variant).
//
// The original overnight spec called for a Claude-with-prompt-caching path
// falling back to Gemini. ANTHROPIC_API_KEY is not available in this build,
// so INSIGHTS_MODEL selects between Gemini variants instead. The ring of
// acceptable values is intentionally small — unknown values fall back to the
// default so a typo never blows up the insight surface.
//
//   'claude'            → alias for the default (most-capable Gemini)
//   'gemini-2.5-pro'    → higher-reasoning Gemini
//   'gemini-2.5-flash'  → default; fast, cheap
//   'gemini-2.0-flash'  → older flash, used as fallback on 5xx/timeouts
//
// See overnight-report.md for the Maestro recommendation noting the deferred
// Claude + prompt-caching work.
const INSIGHT_MODEL_MAP = {
  'claude':           'gemini-2.5-pro',
  'gemini-2.5-pro':   'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.0-flash': 'gemini-2.0-flash',
};
const INSIGHT_FALLBACK_MODEL = 'gemini-2.0-flash';

function resolveInsightsModel() {
  const raw = (process.env.INSIGHTS_MODEL || 'claude').toLowerCase();
  return INSIGHT_MODEL_MAP[raw] || 'gemini-2.5-flash';
}

// Decide whether an error looks like a retryable Gemini 5xx. The SDK surfaces
// HTTP errors with a numeric `status` on the cause; it also decorates the
// message with the status code, so we string-match as a secondary signal.
function isRetryableGeminiError(err) {
  const code = err?.status || err?.cause?.status || err?.response?.status;
  if (typeof code === 'number' && code >= 500) return true;
  const msg = String(err?.message || '');
  return /\b5\d\d\b/.test(msg) || /ECONNRESET|ETIMEDOUT|UND_ERR_/.test(msg);
}

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

async function callGemini(systemInstruction, userPrompt, { temperature = 0.4, model = MODEL } = {}) {
  const ai = getClient();
  try {
    const result = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      config: { systemInstruction, temperature },
    });
    const text = (result.text || '').trim();
    if (!text) throw new Error('Gemini returned empty response');
    return text;
  } catch (err) {
    const wrapped = new Error(`Gemini call failed: ${err.message}`);
    wrapped.cause = err;
    wrapped.status = err?.status || err?.cause?.status;
    throw wrapped;
  }
}

// C-I-01: insights-specific call. Tries the INSIGHTS_MODEL selection first
// and falls back to gemini-2.0-flash on 5xx / transient errors so a Gemini
// hiccup doesn't burn the user's manual insight click.
async function callInsightsModel(systemInstruction, userPrompt, opts = {}) {
  const primary = resolveInsightsModel();
  try {
    return await callGemini(systemInstruction, userPrompt, { ...opts, model: primary });
  } catch (err) {
    if (primary !== INSIGHT_FALLBACK_MODEL && isRetryableGeminiError(err)) {
      return callGemini(systemInstruction, userPrompt, { ...opts, model: INSIGHT_FALLBACK_MODEL });
    }
    throw err;
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

  return callInsightsModel(INSIGHT_SYSTEM, prompt);
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

// ---------------------------------------------------------------------------
// Meeting prep — gentle, reminder-only synthesis of what the USER has already
// written (agenda items + user-authored profiles). Strictly distinct from the
// Gloss-backed `generateMeetingBrief`: this prompt forbids inventing advice
// and only reflects what's in the user's own notes.
// ---------------------------------------------------------------------------

const PREP_SYSTEM = `
You are helping the user remember what they already wrote before a meeting.
You MUST NOT invent advice, opinions, or facts.

You will receive:
  - the event (title, time, description, location),
  - per-attendee data: an optional user-authored profile (relationship_type,
    personality_notes, practical_notes, relationship_goals, followup_days),
    a Gloss-backed profile (growth_note, linked_collections, recent_context),
    recent communication cadence, and open agenda items scoped to that person,
  - event-scoped agenda items.

Absolute rules:
1. Your entire output must reflect what the user has already written. If a
   field is empty, do not mention it.
2. NEVER invent conversation topics, advice, tactics, or framings. If the
   only content the user has is "coffee: oat milk latte", surface exactly
   that — do not extrapolate it into relationship advice.
3. Paraphrase user-written text lightly so the output reads naturally, but
   do not add new ideas.
4. Tone: quiet, plain, second-person. Never coaching-voice. Never flowery.
5. If the user has written nothing relevant, say "No reminders on file for
   this meeting." and stop.

Output format (markdown):
- Lead with 1 line: meeting title + when, then a blank line.
- If event-scoped agenda items exist, a "## Agenda" section with those as
  bullets. Skip if empty.
- One "## <Attendee Name>" section per attendee who has ANY user-written
  data (profile fields, person-scoped agenda items, or prior relationship
  notes). Under each:
    - If a relationship_type exists, mention it in one short phrase.
    - Bullets for: open person-scoped agenda items (prefixed "reminder:"),
      practical notes ("practical:"), personality notes ("how they are:"),
      and relationship goals ("goal:"). Omit categories with no content.
- End without a summary. Do not add a closing sentence.
`.trim();

async function generateMeetingPrep({ event, attendeeProfiles, eventAgenda }) {
  const evt = {
    title:       event?.title || '(untitled)',
    start_time:  event?.start_time || null,
    location:    event?.location || null,
    description: truncate(event?.description || '', 200),
  };

  const attendees = (attendeeProfiles || []).map(a => ({
    contact:         a.contact,
    user_profile:    a.userProfile || null,
    person_agenda:   Array.isArray(a.personAgenda) ? a.personAgenda : [],
    gloss_profile:   formatGlossProfile(a.glossProfile),
    recent_comms:    formatRecentComms(a.recentComms),
  }));

  const anyContent =
    (eventAgenda && eventAgenda.length) ||
    attendees.some(a =>
      a.user_profile || a.person_agenda.length ||
      (a.gloss_profile && (a.gloss_profile.growth_note || a.gloss_profile.recent_context.length))
    );

  if (!anyContent) return 'No reminders on file for this meeting.';

  const prompt = [
    'Event:',
    '```json', JSON.stringify(evt, null, 2), '```',
    '',
    'Event-scoped agenda items:',
    '```json', JSON.stringify(eventAgenda || [], null, 2), '```',
    '',
    `Attendees (${attendees.length}):`,
    '```json', JSON.stringify(attendees, null, 2), '```',
    '',
    'Write the meeting prep per the rules in the system prompt. Reflect only content present in the JSON above.',
  ].join('\n');

  return callGemini(PREP_SYSTEM, prompt, { temperature: 0.2 });
}

// ---------------------------------------------------------------------------
// Meeting playbook — applies a named conversational framework (Challenger,
// SPIN, GROW, Radical Candor, NVC, etc) to the specific meeting. Unlike
// `generateMeetingPrep`, this one IS allowed to write sample phrasings and
// illustrative dialogue, because the point is to show what the meeting could
// look like structured through the chosen model.
// ---------------------------------------------------------------------------

const PLAYBOOK_MODELS = {
  auto: {
    label: 'Auto (pick the best fit)',
    blurb: 'Scan the meeting context and choose whichever framework below best fits. Say which you chose and why in one line before the outline.',
  },
  challenger: {
    label: 'Challenger Sale',
    blurb: `Challenger Sale (Dixon & Adamson). Reps win by TEACHING customers something new, TAILORING to the individual, and TAKING CONTROL of the conversation. Commercial-teaching arc:
  1. Warmer — show you understand their world better than they expect.
  2. Reframe — introduce a surprising insight that challenges their assumptions.
  3. Rational Drowning — data/logic showing the problem is bigger or different than they think.
  4. Emotional Impact — make it personal: what this means for them specifically.
  5. A New Way — describe the different approach needed.
  6. Your Solution — map your solution to the new way.`,
  },
  spin: {
    label: 'SPIN Selling',
    blurb: `SPIN Selling (Neil Rackham). Sequence of question types:
  - Situation questions — surface facts about their current state (use sparingly).
  - Problem questions — uncover pains, difficulties, dissatisfactions.
  - Implication questions — make the problem's consequences concrete.
  - Need-payoff questions — get them to articulate the value of solving it.`,
  },
  sandler: {
    label: 'Sandler 7-Step',
    blurb: `Sandler Selling System — seven stages:
  1. Bonding & rapport.
  2. Up-front contract — agree on the meeting's purpose, time, outcomes.
  3. Pain — uncover real business pain, not surface symptoms.
  4. Budget — money/time/effort they'll commit.
  5. Decision — who decides and how.
  6. Fulfillment — present only what maps to uncovered pain.
  7. Post-sell — lock in the decision, pre-empt buyer's remorse.`,
  },
  meddic: {
    label: 'MEDDIC qualification',
    blurb: `MEDDIC — enterprise qualification checklist:
  - Metrics (quantified economic impact)
  - Economic buyer (who signs)
  - Decision criteria (what they'll evaluate on)
  - Decision process (steps, timeline)
  - Identify pain (the real driver)
  - Champion (internal advocate with power)`,
  },
  grow: {
    label: 'GROW coaching',
    blurb: `GROW model (Whitmore) — coaching conversation:
  - Goal: what do they want from this conversation / this topic?
  - Reality: what's actually happening now?
  - Options: what could they do?
  - Will / Way-forward: what WILL they do, by when?`,
  },
  'radical-candor': {
    label: 'Radical Candor 1:1',
    blurb: `Radical Candor (Kim Scott) — care personally AND challenge directly. 1:1s are employee-led: they set the agenda. Feedback should be specific, sincere, helpful, private (for criticism) / public (for praise), and timely. Avoid ruinous empathy and manipulative insincerity.`,
  },
  'crucial-conversations': {
    label: 'Crucial Conversations (STATE)',
    blurb: `Crucial Conversations — for high-stakes, emotional, or disagreement-heavy talks.
  Start With Heart (check your motives). Make it safe. Then STATE your path:
  - Share your facts (start with what you observed, not conclusions).
  - Tell your story (your interpretation, owned as an interpretation).
  - Ask for theirs.
  - Talk tentatively (soften absolute claims).
  - Encourage testing (invite pushback).`,
  },
  nvc: {
    label: 'Nonviolent Communication',
    blurb: `NVC (Marshall Rosenberg) — four components, in order:
  - Observation (what you literally observed, no evaluation).
  - Feeling (what you feel about it).
  - Need (the underlying need driving the feeling).
  - Request (a concrete, doable, present-tense ask).
  Use to raise a sensitive topic without triggering defensiveness.`,
  },
  'fisher-ury': {
    label: 'Getting to Yes (principled negotiation)',
    blurb: `Fisher & Ury, Getting to Yes — principled negotiation:
  - Separate the people from the problem.
  - Focus on interests, not positions.
  - Invent options for mutual gain before deciding.
  - Insist on objective criteria.
  Also: know your BATNA (best alternative to a negotiated agreement).`,
  },
  'start-stop-continue': {
    label: 'Start / Stop / Continue',
    blurb: `Start / Stop / Continue — lightweight retro framing. For each side of the relationship or project: what should we START doing, STOP doing, CONTINUE doing? Good for reviews, retros, partnership check-ins.`,
  },
  'five-whys': {
    label: 'Five Whys (root cause)',
    blurb: `Five Whys (Toyota / Sakichi Toyoda) — starting from the presenting problem, ask "why?" up to five times to peel back to a root cause rather than stopping at symptoms. Best for problem-solving or incident-review meetings.`,
  },
  'star-feedback': {
    label: 'STAR (feedback / review)',
    blurb: `STAR — for giving concrete feedback or running a review:
  - Situation — when and where.
  - Task — what needed to happen.
  - Action — what they actually did.
  - Result — what that produced.
  Makes feedback specific rather than characterological.`,
  },
};

function playbookModelList() {
  return Object.entries(PLAYBOOK_MODELS).map(([key, m]) => ({ key, label: m.label, builtin: true }));
}

function isBuiltinPlaybookKey(key) {
  return !!PLAYBOOK_MODELS[key];
}

const PLAYBOOK_SYSTEM = `
You help the user pre-walk a meeting through a named conversational framework.
You will receive:
  - the event (title, time, description, location),
  - per-attendee data (user-authored profile, Gloss-backed notes, recent-comms cadence, person-scoped agenda),
  - event-scoped agenda items,
  - the chosen FRAMEWORK with a short description of its structure.

Your job:
1. Walk through the framework's stages/steps IN ORDER, applied to THIS specific meeting and these specific people.
2. For each stage, show: (a) what that stage means in one line, (b) how it lands in this meeting given the known context, and (c) 1-2 sample sentences the user could actually say — written in plain, natural speech (not corporate-speak).
3. You MAY invent illustrative phrasings — that's the point. But every concrete claim about the person or relationship must trace back to provided data (profile, agenda, Gloss notes, cadence). If a stage is hard to fill because context is thin, say "light context here — use this as a prompt, not a script."
4. Ground the opening and closing explicitly in the meeting's real agenda items when they exist.
5. Respect the user's stated relationship goals and personality notes — don't suggest a tone that contradicts them.

Tone: direct, practical, second-person. No MBA-speak, no coach-voice, no "leverage" / "circle back" / "value-add". Short sentences. It is fine to be tentative where the context is thin.

Output format (markdown):
  - Line 1: "# <Meeting title> — <Framework label>"
  - Line 2: one-sentence framing of why this framework suits this meeting (or, if model=auto, which you chose and why).
  - Blank line.
  - One "## <Stage name>" section per stage of the framework. Under each:
    - a 1-line reminder of what the stage is.
    - 1-3 bullets mapping it to this meeting.
    - a "> " blockquote with 1-2 sample lines you could actually say.
  - End with "## Watch-outs" listing 1-3 pitfalls specific to this meeting / these people. Omit if nothing specific comes to mind.
`.trim();

async function generateMeetingPlaybook({ event, attendeeProfiles, eventAgenda, model, customModel }) {
  // Resolve the framework: custom model object wins; otherwise look up by key;
  // otherwise fall back to 'auto'.
  let modelKey, chosen;
  if (customModel && customModel.label && customModel.blurb) {
    modelKey = customModel.key || 'custom';
    chosen = { label: customModel.label, blurb: customModel.blurb };
  } else if (PLAYBOOK_MODELS[model]) {
    modelKey = model;
    chosen = PLAYBOOK_MODELS[model];
  } else {
    modelKey = 'auto';
    chosen = PLAYBOOK_MODELS.auto;
  }

  const evt = {
    title:       event?.title || '(untitled)',
    start_time:  event?.start_time || null,
    location:    event?.location || null,
    description: truncate(event?.description || '', 300),
  };

  const attendees = (attendeeProfiles || []).map(a => ({
    contact:       a.contact,
    user_profile:  a.userProfile || null,
    person_agenda: Array.isArray(a.personAgenda) ? a.personAgenda : [],
    gloss_profile: formatGlossProfile(a.glossProfile),
    recent_comms:  formatRecentComms(a.recentComms),
  }));

  const prompt = [
    `Framework: ${chosen.label}${modelKey === 'auto' ? '' : ` (key: ${modelKey})`}`,
    '',
    'Framework description:',
    chosen.blurb,
    '',
    modelKey === 'auto'
      ? 'Since the user picked "auto", evaluate the context below and pick whichever of the standard frameworks (Challenger, SPIN, Sandler, MEDDIC, GROW, Radical Candor 1:1, Crucial Conversations STATE, NVC, Getting-to-Yes, Start/Stop/Continue, Five Whys, STAR) best fits. State your pick on line 2.'
      : '',
    '',
    'Event:',
    '```json', JSON.stringify(evt, null, 2), '```',
    '',
    'Event-scoped agenda items:',
    '```json', JSON.stringify(eventAgenda || [], null, 2), '```',
    '',
    `Attendees (${attendees.length}):`,
    '```json', JSON.stringify(attendees, null, 2), '```',
    '',
    'Walk the meeting through this framework per the rules in the system prompt.',
  ].filter(Boolean).join('\n');

  return callGemini(PLAYBOOK_SYSTEM, prompt, { temperature: 0.5 });
}

// ---------------------------------------------------------------------------
// Message template — AI-drafted message in user's writing style, with channel
// recommendation (text vs email) based on relationship type + comm history.
// ---------------------------------------------------------------------------

const MESSAGE_TEMPLATE_SYSTEM = `
You are helping the user draft a short, personal message to someone in their life.

You will receive:
  - the contact's name,
  - the occasion (e.g. "birthday", "anniversary", "check-in", "congratulations"),
  - an optional user-authored profile (relationship_type, personality_notes, practical_notes),
  - channel_history: counts of sent iMessages and sent emails to infer the usual channel,
  - style_samples: the user's recent SENT messages and emails to this contact (to infer writing style).

Your job:
1. Choose channel: recommend 'text' if there are sent iMessages AND relationship_type is personal
   (not a professional/work label like "coworker", "colleague", "client", "manager", "boss").
   Recommend 'email' otherwise.
2. Write a short draft message. Match the user's writing style from style_samples.
   - For 'text': 1-3 sentences, casual, no sign-off needed.
   - For 'email': subject line + 2-4 sentences, light sign-off matching their style.
3. Write a one-sentence rationale explaining the channel choice.

Absolute rules:
- NEVER invent facts not in the provided context (kids' names, job details, etc.).
- Use practical_notes for personal details ONLY if provided.
- If no style samples exist, keep the draft natural and fitting for the occasion.
- The draft must sound like the user wrote it, not like a greeting card.
- Output JSON only — no markdown fences, no extra keys.

Output exactly this JSON shape:
{"channel":"text","rationale":"one sentence","subject":null,"draft":"the message body"}

For email, subject is a string. For text, subject is null.
`.trim();

async function generateMessageTemplate({ contact, profile, recentComms, sentSamples, occasion }) {
  const payload = {
    contact,
    occasion,
    profile: profile ? {
      relationship_type: profile.relationship_type || null,
      personality_notes: profile.personality_notes || null,
      practical_notes:   profile.practical_notes   || null,
    } : null,
    channel_history: {
      imessage_sent_count: (sentSamples?.sent_messages || []).length,
      email_sent_count:    (sentSamples?.sent_emails   || []).length,
    },
    style_samples: {
      recent_texts:  (sentSamples?.sent_messages || []).slice(0, 10)
        .map(m => ({ text: truncate(m.text, 200), sent_at: m.sent_at })),
      recent_emails: (sentSamples?.sent_emails   || []).slice(0, 10)
        .map(e => ({ subject: e.subject, snippet: truncate(e.snippet, 150) })),
    },
  };

  const prompt = [
    `Contact: ${contact}`,
    `Occasion: ${occasion}`,
    '',
    'Context (JSON):',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    'Output the JSON object per the system prompt. No markdown fences.',
  ].join('\n');

  const raw = await callGemini(MESSAGE_TEMPLATE_SYSTEM, prompt, { temperature: 0.6 });
  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('AI returned malformed JSON for message template');
  }
}

module.exports = {
  generateContactInsight,
  generateMeetingBrief,
  generateMeetingPrep,
  generateMeetingPlaybook,
  generateMessageTemplate,
  playbookModelList,
  isBuiltinPlaybookKey,
  PLAYBOOK_MODELS,
  // C-I-01: insights model selection (exported for tests)
  resolveInsightsModel,
  isRetryableGeminiError,
  INSIGHT_MODEL_MAP,
  INSIGHT_FALLBACK_MODEL,
  callInsightsModel,
  // Exported for testing / introspection
  INSIGHT_SYSTEM,
  BRIEF_SYSTEM,
  PREP_SYSTEM,
  PLAYBOOK_SYSTEM,
  MESSAGE_TEMPLATE_SYSTEM,
};
