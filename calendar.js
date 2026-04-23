'use strict';

// Google Calendar API integration — consumes tokens issued by gmail.js OAuth flow.

const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

function getCalendarScopes() {
  return SCOPES.slice();
}

function hasCalendarScope(tokens) {
  if (!tokens || typeof tokens.scope !== 'string') return false;
  return tokens.scope.split(/\s+/).includes(SCOPES[0]);
}

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
}

// Returns { calendars: [{id, summary, primary, backgroundColor}], refreshedTokens }
async function fetchCalendarList(tokenJson) {
  const client = makeClient();
  client.setCredentials(JSON.parse(tokenJson));
  let refreshedTokens = null;
  client.on('tokens', t => { refreshedTokens = t; });
  const calendar = google.calendar({ version: 'v3', auth: client });
  const { data } = await calendar.calendarList.list({ minAccessRole: 'reader' });
  const calendars = (data.items || []).map(c => ({
    id: c.id,
    summary: c.summary || c.id,
    primary: !!c.primary,
    backgroundColor: c.backgroundColor || null,
  }));
  return { calendars, refreshedTokens };
}

// Returns { events: [...], refreshedTokens }
// Window is (now - pastDays) .. (now + futureDays). Past events are needed so
// contact timelines can show what already happened; future events feed briefs.
async function fetchCalendarEvents(tokenJson, { pastDays = 180, futureDays = 30, calendarIds = ['primary'] } = {}) {
  const client = makeClient();
  client.setCredentials(JSON.parse(tokenJson));

  let refreshedTokens = null;
  client.on('tokens', t => { refreshedTokens = t; });

  const calendar = google.calendar({ version: 'v3', auth: client });

  const now = Date.now();
  const start = new Date(now - pastDays * 24 * 60 * 60 * 1000);
  const end = new Date(now + futureDays * 24 * 60 * 60 * 1000);

  const ids = Array.isArray(calendarIds) && calendarIds.length ? calendarIds : ['primary'];
  const events = [];

  for (const calId of ids) {
    let pageToken;
    try {
      do {
        const { data } = await calendar.events.list({
          calendarId: calId,
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 250,
          pageToken,
        });

        for (const ev of data.items || []) {
          if (ev.status === 'cancelled') continue;

          const attendees = (ev.attendees || []).map(a => ({
            name: a.displayName || null,
            email: (a.email || '').toLowerCase(),
            response: a.responseStatus || null,
          }));

          const selfAtt = (ev.attendees || []).find(a => a.self);
          if (selfAtt && selfAtt.responseStatus === 'declined') continue;

          const startDateTime = ev.start?.dateTime || ev.start?.date || null;
          const endDateTime = ev.end?.dateTime || ev.end?.date || null;
          if (!startDateTime) continue;

          events.push({
            id: ev.id,
            calendar_id: calId,
            date: deriveLocalDate(ev.start),
            start_time: startDateTime,
            end_time: endDateTime,
            title: ev.summary || '(no title)',
            description: ev.description || null,
            location: ev.location || null,
            attendees,
            html_link: ev.htmlLink || null,
          });
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    } catch (err) {
      console.warn(`[calendar] list error for ${calId}: ${err.message}`);
    }
  }

  return { events, refreshedTokens };
}

// Derive a YYYY-MM-DD local date from a Google event start object.
// All-day events use start.date (already YYYY-MM-DD). Timed events use start.dateTime
// and we format in the event's local timezone if present, else system local.
function deriveLocalDate(start) {
  if (!start) return null;
  if (start.date) return start.date; // all-day
  if (!start.dateTime) return null;

  const d = new Date(start.dateTime);
  if (start.timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: start.timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const day = parts.find(p => p.type === 'day')?.value;
      if (y && m && day) return `${y}-${m}-${day}`;
    } catch (_) { /* fall through */ }
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { fetchCalendarEvents, fetchCalendarList, getCalendarScopes, hasCalendarScope };
