'use strict';

// Plain English → a structured file query. No AI needed: a small grammar that covers how people
// describe files ("pdfs from github last week", "big videos I haven't opened in a month").
// Everything it recognises becomes a chip the person can see and remove; leftover words are
// matched against file names and text.

const DAY = 86400000;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3));
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Words that start a time phrase: "opened last week", "edited on monday", "used in march".
const TIME_CUE = `(?:today|yesterday|this|last|past|previous|in|on|since|before|after|during|recently|lately|over|within|\\d+|a while|${WEEKDAYS.join('|')})`;
// Whole month names and their usual abbreviations only: "decks", "marketing" and "separate" aren't months.
const MONTH_RE = `(?:${[...MONTHS, 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec'].join('|')})`;
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, couple: 2, few: 3 };

// Words for Inlet's built-in categories (ids from defaults.js).
const KIND_WORDS = {
  images: ['image', 'images', 'photo', 'photos', 'picture', 'pictures', 'pic', 'pics', 'graphics'],
  documents: ['document', 'documents', 'doc', 'docs'],
  spreadsheets: ['spreadsheet', 'spreadsheets', 'sheet', 'sheets', 'excel', 'workbook', 'workbooks'],
  presentations: ['presentation', 'presentations', 'slides', 'slide', 'deck', 'decks', 'keynote', 'powerpoint'],
  videos: ['video', 'videos', 'movie', 'movies', 'clip', 'clips', 'recording', 'recordings', 'film'],
  audio: ['audio', 'music', 'song', 'songs', 'podcast', 'podcasts', 'track', 'tracks', 'voice memo'],
  archives: ['archive', 'archives', 'compressed'],
  installers: ['installer', 'installers', 'setup', 'setups', 'disk image', 'disk images'],
  code: ['code', 'script', 'scripts', 'source code'],
  design: ['design', 'designs', 'mockup', 'mockups'],
  fonts: ['font', 'fonts', 'typeface', 'typefaces'],
  keys: ['certificate', 'certificates', 'cert', 'certs', 'key file', 'key files', 'ssh key', 'ssh keys'],
};

// Apps that download or deliver files, as the quarantine tag names them (see provenance.js).
const APPS = {
  safari: 'Safari', chrome: 'Chrome', 'google chrome': 'Chrome', firefox: 'Firefox', brave: 'Brave', edge: 'Edge', arc: 'Arc',
  airdrop: 'AirDrop', 'air drop': 'AirDrop', teams: 'Microsoft Teams', 'microsoft teams': 'Microsoft Teams', slack: 'Slack',
  notion: 'Notion', mail: 'Mail', 'apple mail': 'Mail', outlook: 'Microsoft Outlook', messages: 'Messages', imessage: 'Messages',
  whatsapp: 'WhatsApp', telegram: 'Telegram', discord: 'Discord', zoom: 'zoom.us', word: 'Microsoft Word', preview: 'Preview',
};

// People we can't identify from file metadata ("the designer shared", "my friend airdropped").
const ROLES = new Set(['manager', 'boss', 'friend', 'friends', 'colleague', 'colleagues', 'coworker', 'coworkers', 'client', 'clients', 'customer', 'mom', 'mum', 'dad',
  'mother', 'father', 'brother', 'sister', 'son', 'daughter', 'wife', 'husband', 'partner', 'designer', 'developer', 'teacher', 'professor', 'tutor', 'accountant',
  'lawyer', 'doctor', 'landlord', 'recruiter', 'hr', 'team', 'someone', 'somebody', 'he', 'she', 'they', 'him', 'her', 'agent', 'bank', 'school', 'office']);
// Extensions that are also everyday words: only a file type when written like one (see parse).
const AMBIGUOUS_EXTS = new Set(['doc', 'key', 'app', 'md', 'c', 'h', 'ai', 'db', 'pages', 'numbers', 'sketch', 'go', 'fig', 'dump', 'swift', 'java', 'raw', 'rs', 'rb', 'in']);
const SENT_VERBS ='sent|shared|gave|emailed|mailed|forwarded|uploaded|texted|messaged';

const STOPWORDS = new Set(['i', 'me', 'my', 'mine', 'the', 'a', 'an', 'that', 'which', 'those', 'these', 'this', 'file', 'files', 'all', 'any', 'show',
  'find', 'get', 'give', 'where', 'is', 'are', 'was', 'were', 'did', 'do', 'from', 'with', 'of', 'for', 'to', 'in', 'on', 'at', 'and', 'or', 'some',
  'please', 'can', 'you', 'what', 'ones', 'one', 'thing', 'things', 'stuff', 'got', 'have', 'had', 'has', 'downloaded', 'download', 'downloads',
  'saved', 'sent', 'received', 'shared', 'by', 'it', 'its', 'them', 'there', 'here', 'about', 'just', 'recently', 'recent', 'latest', 'last', 'new',
  'look', 'looking', 'need', 'want', 'bring', 'up', 'me', 'we', 'our', 'went', 'put', 'into', 'called', 'named', 'like', 'kind',
  'thing', 'anything', 'something', 'everything', 'eating', 'taking', 'filling', 'using', 'space', 'disk', 'storage', 'delete', 'deleting', 'remove',
  'clean', 'cleaning', 'save', 'keep', 'kept', 'while', 'ago', 'back', 'time', 'can', 'could', 'should', 'would', 'might', 'will', 'also', 'needed',
  'emailed', 'mailed', 'forwarded', 'uploaded', 'gave', 'mac', 'computer', 'laptop', 'folder', 'folders', 'somewhere', 'maybe', 'probably', 'think']);

const UNITS = { b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2, meg: 1024 ** 2, megs: 1024 ** 2, gb: 1024 ** 3, g: 1024 ** 3, gig: 1024 ** 3, gigs: 1024 ** 3 };

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s] ?? null);
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Remove a regex match from the working text and return it (null if none). */
function take(state, re) {
  const m = state.text.match(re);
  if (!m) return null;
  state.text = `${state.text.slice(0, m.index)} ${state.text.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ');
  return m;
}

function parseTime(state, now) {
  const today = startOfDay(now);
  const range = (from, to, label) => ({ from, to, label });
  let m;
  const out = {};

  // "haven't opened in a month", "not opened since march", "never opened". Read first, so "opened" here isn't
  // taken as which date is meant, and keep going: "pdfs from last week I never opened" has a date as well.
  const NOT = "(?:haven'?t|have not|hasn'?t|has not|didn'?t|did not|not)\\s+(?:been\\s+|ever\\s+)?";
  const OPENED = '(?:opened|used|looked at|touched)';
  if (take(state, new RegExp(`\\b(?:never|not ever)\\s+(?:been\\s+)?${OPENED}\\b`))) {
    Object.assign(out, { notOpenedDays: 36500, notOpenedLabel: 'never opened' });
  } else if ((m = take(state, new RegExp(`\\b${NOT}${OPENED}\\s+(?:since|after)\\s+(${MONTH_RE}|\\d{4})\\b`)))) {
    const [from] = monthOrYear(m[1], now);
    Object.assign(out, { notOpenedDays: Math.max(1, Math.ceil((now.getTime() - from) / DAY)), notOpenedLabel: `not opened since ${pretty(m[1])}` });
  } else if ((m = take(state, new RegExp(`\\b${NOT}${OPENED}?\\s*(?:in|for|since)\\s+(?:the\\s+)?(?:(?:last|past)\\s+)?(\\w+)?\\s*(day|week|month|year)s?\\b`)))) {
    const n = num(m[1] || '1') || 1;
    const days = n * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
    Object.assign(out, { notOpenedDays: days, notOpenedLabel: `not opened in ${n === 1 ? `a ${m[2]}` : `${n} ${m[2]}s`}` });
  } else if (take(state, new RegExp(`\\b${NOT}${OPENED}\\b`))) {
    Object.assign(out, { notOpenedDays: 36500, notOpenedLabel: 'never opened' }); // "files I haven't opened": no period given
  }

  // Which date the person means. Default: when it arrived (downloaded).
  // Only when it's about what someone did ("I opened", "we edited") or a date follows ("opened last week"):
  // in "pdfs about used cars" or "used car receipts", "used" describes the thing.
  const fieldRe = (verbs) => new RegExp(`\\b(?:(?:i|we|you|he|she|they)(?:'ve| have| had)?\\s+(?:last\\s+|first\\s+|recently\\s+)?(?:${verbs})|(?:${verbs})(?=\\s+${TIME_CUE}\\b))\\b`);
  let field = 'downloaded';
  if (take(state, fieldRe('opened|used|looked at|viewed|read'))) field = 'opened';
  else if (take(state, fieldRe('edited|modified|changed|updated|worked on'))) field = 'modified';

  const fieldWord = { downloaded: 'downloaded', opened: 'opened', modified: 'changed' }[field];
  let t = null;
  if (take(state, /\bthis morning\b/)) t = range(today, today + DAY / 2, 'this morning');
  else if (take(state, /\bthis afternoon\b/)) t = range(today + DAY / 2, today + DAY * 0.75, 'this afternoon');
  else if (take(state, /\b(?:this evening|tonight)\b/)) t = range(today + DAY * 0.75, today + DAY, 'this evening');
  else if (take(state, /\btoday\b/)) t = range(today, today + DAY, 'today');
  else if (take(state, /\byesterday\b/)) t = range(today - DAY, today, 'yesterday');
  else if ((m = take(state, /\b(?:in |over |within |during )?(?:the )?past\s+(day|week|month|year)\b/))) {
    // "the past week": a rolling window up to now (unlike "last week", the calendar week before this one)
    t = range(today - UNIT_DAYS[m[1]] * DAY + DAY, now.getTime() + 1, `past ${m[1]}`);
  } else if ((m = takeCount(state, /\b(?:in the |over the |within the )?(?:last|past)\s+(?:a\s+)?(\w+)(?:\s+of)?\s+(day|week|month|year)s?\b/))) {
    const days = m.hi * UNIT_DAYS[m[2]];
    t = range(today - days * DAY + DAY, now.getTime() + 1, `last ${m.label} ${m[2]}${m.hi === 1 ? '' : 's'}`);
  } else if ((m = takeCount(state, /\b(?:a\s+)?(\w+)(?:\s+of)?\s+(day|week|month|year)s?\s+ago\b/))) {
    // "3 weeks ago" is that week; "a few weeks ago" spans the likely range (2 to 4 weeks back)
    const unit = UNIT_DAYS[m[2]];
    t = range(today - m.hi * unit * DAY, today - m.lo * unit * DAY + unit * DAY, `${m.label} ${m[2]}${m.hi === 1 ? '' : 's'} ago`);
  } else if ((m = take(state, /\b(last|this|previous)\s+weekend\b/))) {
    const sinceSat = (now.getDay() + 1) % 7; // days since the most recent Saturday
    const sat = today - sinceSat * DAY - (m[1] === 'this' ? 0 : (sinceSat <= 1 ? 7 * DAY : 0));
    t = range(sat, sat + 2 * DAY, `${m[1] === 'this' ? 'this' : 'last'} weekend`);
  } else if ((m = take(state, /\b(?:(last|this|previous)\s+|in (?:the )?)(spring|summer|autumn|fall|winter)\b/))) {
    const start = { spring: 2, summer: 5, autumn: 8, fall: 8, winter: 11 }[m[2]]; // month index (Northern Hemisphere)
    let year = now.getFullYear();
    const from = (y) => new Date(y, start, 1).getTime();
    const to = (y) => new Date(y, start + 3, 1).getTime();
    if (m[1] === 'this') { if (from(year) > now.getTime()) year -= 1; } else { while (to(year) > now.getTime()) year -= 1; }
    t = range(from(year), to(year), `${m[1] === 'this' ? 'this' : 'last'} ${m[2]}`);
  } else if (take(state, /\b(?:a while (?:ago|back)|some time ago|ages ago|long ago)\b/)) {
    t = range(0, today - 30 * DAY, 'over a month ago');
  } else if ((m = take(state, /\bolder than\s+(\w+)\s+(day|week|month|year)s?\b/))) {
    const n = num(m[1]) || 1;
    t = range(0, today - n * { day: 1, week: 7, month: 30, year: 365 }[m[2]] * DAY, `older than ${n} ${m[2]}${n === 1 ? '' : 's'}`);
  } else if (take(state, /\b(?:old|older|ancient|outdated)\b/)) {
    t = range(0, today - 180 * DAY, 'over 6 months old');
  } else if (take(state, /\b(?:recently|recent|lately|latest|newest|just)\b/)) {
    t = range(today - 13 * DAY, now.getTime() + 1, 'last 2 weeks');
  } else if (take(state, /\bthis week\b/)) {
    const start = today - ((now.getDay() + 6) % 7) * DAY; // weeks start on Monday
    t = range(start, now.getTime() + 1, 'this week');
  } else if (take(state, /\b(?:last|previous) week\b/)) {
    const start = today - ((now.getDay() + 6) % 7) * DAY;
    t = range(start - 7 * DAY, start, 'last week');
  } else if (take(state, /\bthis month\b/)) {
    t = range(new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime() + 1, 'this month');
  } else if (take(state, /\b(?:last|previous) month\b/)) {
    t = range(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime(), 'last month');
  } else if (take(state, /\bthis year\b/)) {
    t = range(new Date(now.getFullYear(), 0, 1).getTime(), now.getTime() + 1, 'this year');
  } else if (take(state, /\b(?:last|previous) year\b/)) {
    t = range(new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime(), 'last year');
  } else if ((m = take(state, /\b(?:on |last )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) {
    const back = ((now.getDay() - WEEKDAYS.indexOf(m[1]) + 7) % 7) || 7; // the most recent one before today
    t = range(today - back * DAY, today - back * DAY + DAY, `on ${m[1][0].toUpperCase()}${m[1].slice(1)}`);
  } else if ((m = take(state, new RegExp(`\\b(before|after|since)\\s+(\\d{4}|${MONTH_RE})\\b`)))) {
    const [from, to] = monthOrYear(m[2], now);
    if (m[1] === 'before') t = range(0, from, `before ${pretty(m[2])}`);
    else t = range(m[1] === 'after' ? to : from, now.getTime() + 1, `${m[1]} ${pretty(m[2])}`);
  } else if ((m = takeMonth(state))) {
    const [from, to] = monthOrYear(m[1] + (m[2] ? ` ${m[2]}` : ''), now);
    if (from !== null) t = range(from, to, `in ${pretty(m[1])}${m[2] ? ` ${m[2]}` : ''}`);
  } else if ((m = take(state, /\b(?:in |during |from )(\d{4})\b/))) {
    const [from, to] = monthOrYear(m[1], now);
    t = range(from, to, `in ${m[1]}`);
  }
  if (t) out.time = { field, from: t.from, to: t.to, label: field === 'downloaded' ? t.label : `${fieldWord} ${t.label}` };
  return out;
}

/** "in july", "march 2025", "sept": a month, with or without "in"/"during"/"from". "may" needs one of those, or a year. */
function takeMonth(state) {
  const re = new RegExp(`\\b(in |during |from )?(${MONTH_RE})(?:\\s+(\\d{4}))?\\b`, 'g');
  for (const m of state.text.matchAll(re)) {
    if (m[2] === 'may' && !m[1] && !m[3]) continue; // "files I may have saved"
    state.text = `${state.text.slice(0, m.index)} ${state.text.slice(m.index + m[0].length)}`.replace(/\s+/g, ' ');
    return [m[0], m[2], m[3]];
  }
  return null;
}

const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 };
// Counts people say without a number: a likely range rather than a guess.
const VAGUE = { couple: [1, 3], few: [2, 4], several: [3, 7] };

/**
 * Take a "<count> <unit>" match only when the count is understood ("3", "two", "a couple of", "a few").
 * Anything else ("pdfs from…", "old weeks") is left alone instead of being read as 1.
 * Returns the match plus { lo, hi, label }.
 */
function takeCount(state, re) {
  const m = state.text.match(re);
  if (!m) return null;
  const word = m[1];
  let lo; let hi;
  if (VAGUE[word]) [lo, hi] = VAGUE[word];
  else if (num(word) != null) lo = hi = num(word);
  else return null;
  take(state, re);
  return Object.assign(m, { lo, hi, label: { couple: 'a couple of', few: 'a few', several: 'several' }[word] || String(hi) });
}

const pretty = (s) => (/^\d{4}$/.test(s) ? s : `${s[0].toUpperCase()}${s.slice(1)}`);

/** "march" (the most recent March), "march 2025", "2025" → [from, to) in ms. */
function monthOrYear(s, now) {
  const [word, yearStr] = s.split(' ');
  if (/^\d{4}$/.test(word)) return [new Date(Number(word), 0, 1).getTime(), new Date(Number(word) + 1, 0, 1).getTime()];
  const idx = MONTH_SHORT.indexOf(word.slice(0, 3));
  if (idx < 0) return [null, null];
  let year = yearStr ? Number(yearStr) : now.getFullYear();
  if (!yearStr && idx > now.getMonth()) year -= 1; // "in november" in September means last November
  return [new Date(year, idx, 1).getTime(), new Date(year, idx + 1, 1).getTime()];
}

function parseSize(state) {
  let m;
  if ((m = take(state, /\b(?:over|more than|bigger than|larger than|above|at least|>)\s*(\d+(?:\.\d+)?)\s*(kb|k|mb|m|megs?|gb|g|gigs?)\b/))) {
    return { size: { min: Number(m[1]) * UNITS[m[2]], label: `over ${m[1]} ${m[2].toUpperCase().replace(/S$/, '')}` } };
  }
  if ((m = take(state, /\b(?:under|less than|smaller than|below|<)\s*(\d+(?:\.\d+)?)\s*(kb|k|mb|m|megs?|gb|g|gigs?)\b/))) {
    return { size: { max: Number(m[1]) * UNITS[m[2]], label: `under ${m[1]} ${m[2].toUpperCase().replace(/S$/, '')}` } };
  }
  if (take(state, /\b(huge|massive|enormous)\b/)) return { size: { min: 500 * UNITS.mb, label: 'over 500 MB' } };
  if (take(state, /\b(big|large|heavy)\b/)) return { size: { min: 50 * UNITS.mb, label: 'over 50 MB' } };
  if (take(state, /\b(small|tiny|little)\b/)) return { size: { max: UNITS.mb, label: 'under 1 MB' } };
  return {};
}

/**
 * Parse a sentence. `categories` are Inlet's categories (to recognise their names and extensions).
 * Returns { kinds, time, notOpenedDays, sources, apps, phrases, words, size, place, inletAction, notes, chips }.
 */
function parse(sentence, { categories = [], folders = [], now = new Date() } = {}) {
  const q = { text: sentence, kinds: [], sources: [], apps: [], phrases: [], words: [], notes: [], place: null, inletAction: null };
  const state = { text: ` ${String(sentence || '').toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'")} ` };
  let m;

  // Exact phrases in quotes are text to look for.
  while ((m = take(state, /"([^"]+)"/))) q.phrases.push(m[1].trim());

  // What Inlet did: "what did inlet move", "files i removed", "sorted yesterday"
  if (take(state, /\b(?:inlet|tidy)\s+(?:moved|sorted|tidied|filed)\b|\bwhat did (?:inlet|tidy) (?:do|move|sort)\b|\b(?:moved|sorted|tidied) by (?:inlet|tidy)\b/)) q.inletAction = 'moved';
  // Only as something someone did ("what did i remove", "files i deleted"), not a description ("background removed").
  else if (take(state, /\bwhat did (?:i|inlet|tidy|you) (?:remove|delete|trash|clean up)\b|\b(?:i|inlet|tidy|you) (?:removed|deleted|trashed|cleaned up)\b|\b(?:removed|deleted|trashed) by (?:me|inlet|tidy)\b/)) q.inletAction = 'removed';

  // Where the files are: "on my desktop", "in documents"
  for (const f of folders) {
    const label = f.label.toLowerCase();
    if (take(state, new RegExp(`\\b(?:on|in|from)\\s+(?:my\\s+|the\\s+)?${escapeRe(label)}(?:\\s+folder)?\\b`))) { q.place = { folderId: f.id, label: f.label }; break; }
  }
  if (!q.place) {
    for (const c of categories) {
      if (c.id === 'other') continue;
      const label = c.folder.toLowerCase();
      if (take(state, new RegExp(`\\bin\\s+(?:my\\s+|the\\s+)?${escapeRe(label)}\\s+folder\\b`))) { q.place = { categoryId: c.id, label: `${c.folder} folder` }; break; }
    }
  }

  Object.assign(q, parseTime(state, now));
  Object.assign(q, parseSize(state));

  // Content: "about X", "mentioning X", "that says X", "with X in it"
  while ((m = take(state, /\b(?:about|mentioning|mentions|regarding|containing|contains|that says|which says|saying|with the words?|with)\s+([a-z0-9][\w.\-]*(?:\s+(?!from\b|on\b|in\b|via\b|and\b|or\b|that\b|i\b)[a-z0-9][\w.\-]*){0,2})\s+in (?:it|them)\b/))) q.phrases.push(m[1]);
  while ((m = take(state, /\b(?:about|mentioning|mentions|regarding|containing|contains|that says|which says|saying)\s+(?:the\s+|a\s+|an\s+|my\s+)?([a-z0-9][\w.\-]*(?:\s+(?!from\b|on\b|in\b|via\b|and\b|or\b|that\b|i\b|last\b|this\b)[a-z0-9][\w.\-]*){0,2})/))) q.phrases.push(m[1]);

  // Apps: "in chrome", "via airdrop", "on teams", "from slack", "airdropped"
  if (take(state, /\bairdropped\b/)) q.apps.push('AirDrop');
  for (const [word, app] of Object.entries(APPS).sort((a, b) => b[0].length - a[0].length)) {
    if (take(state, new RegExp(`\\b(?:in|via|on|from|with|using|through|over)\\s+${escapeRe(word)}\\b`)) && !q.apps.includes(app)) q.apps.push(app);
  }

  // People can't be identified from file metadata: "the designer shared", "from my manager".
  let person = false;
  // Only a role word ("the designer shared") or someone's ("my cousin sent"): in "pdfs shared on slack" or
  // "invoice emailed last week" the word before the verb is what the file is, so leave it for the rest of the parser.
  const roles = [...ROLES].map(escapeRe).join('|');
  while (take(state, new RegExp(`\\b(?:(?:my|our|his|her|their)\\s+[a-z]+|(?:the\\s+|a\\s+)?(?:${roles}))\\s+(?:${SENT_VERBS})\\b`))) person = true;
  while ((m = take(state, /\b(?:from|by)\s+(?:my|our|the|a)\s+([a-z]+)\b/))) {
    if (ROLES.has(m[1])) person = true; else state.text += ` from ${m[1]}`; // "from the hotel" may still be a website
  }
  for (const r of ROLES) if (take(state, new RegExp(`\\b(?:my\\s+|our\\s+)${escapeRe(r)}\\b`))) person = true;
  if (person) q.notes.push('Inlet can’t tell who sent a file, only which website or app it came from.');

  // Websites: "from github", "from github.com", "on amazon", "off youtube"
  while ((m = take(state, /\b(?:from|on|off|via|at)\s+(?:the\s+)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*)(?:\s+(?:website|site|page))?\b/))) {
    const site = m[1];
    if (STOPWORDS.has(site) || /^\d+$/.test(site)) continue;
    q.sources.push(site.replace(/^www\./, ''));
  }
  // A bare domain anywhere: "github.com pdfs"
  while ((m = take(state, /\b([a-z0-9-]+\.(?:com|org|net|io|dev|app|co|ai|edu|gov|in|uk|de|fr|me|so|xyz)(?:\.[a-z]{2})?)\b/))) q.sources.push(m[1].replace(/^www\./, ''));

  // Kinds: screenshots, category words, extensions ("pdfs", ".zip", "heic")
  if (take(state, /\b(screen ?shots?|screen ?captures?|screen ?grabs?)\b/)) q.kinds.push({ type: 'screenshot', label: 'screenshots' });
  for (const [id, words] of Object.entries(KIND_WORDS)) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) continue;
    const re = new RegExp(`\\b(?:${words.map(escapeRe).sort((a, b) => b.length - a.length).join('|')})\\b`);
    if (take(state, re)) q.kinds.push({ type: 'category', id, label: cat.name.toLowerCase() });
  }
  for (const c of categories) {
    if (take(state, new RegExp(`\\b${escapeRe(c.name.toLowerCase())}\\b`)) && !q.kinds.some((k) => k.id === c.id)) q.kinds.push({ type: 'category', id: c.id, label: c.name.toLowerCase() });
  }
  const knownExts = new Set(categories.flatMap((c) => c.extensions));
  const tokens = state.text.split(/\s+/);
  tokens.forEach((word, i) => {
    const w = word.replace(/^\.|[,;!?]$/g, '');
    const ext = knownExts.has(w) ? w : (w.endsWith('s') && knownExts.has(w.slice(0, -1)) ? w.slice(0, -1) : null);
    // Everyday words that are also extensions ("web pages", "phone numbers") count only when written like a
    // file type: ".pages", or "pages files".
    const written = word.startsWith('.') || /^files?$/.test(tokens[i + 1] || '');
    if (ext && (!AMBIGUOUS_EXTS.has(ext) || written)) {
      if (!q.kinds.some((k) => k.ext === ext)) q.kinds.push({ type: 'ext', ext, label: `.${ext}` });
      take(state, new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$)`));
    }
  });

  // Whatever's left: words to find in names or text.
  // Plurals match singulars too: "slips" finds "Salary_Slip.pdf" (the search matches inside names).
  const stem = (w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  q.words = [...new Set(state.text.split(/\s+/).map((w) => w.replace(/[^\w.\-']/g, '').replace(/'s$/, ''))
    .filter((w) => w && w.length > 1 && !STOPWORDS.has(w) && !/^\d{1,2}$/.test(w)).map(stem))];
  q.phrases = [...new Set(q.phrases.map((p) => p.trim()).filter(Boolean))];
  q.sources = [...new Set(q.sources)];

  q.chips = chipsFor(q);
  return q;
}

function chipsFor(q) {
  const chips = [];
  for (const k of q.kinds) chips.push({ key: `kind:${k.ext || k.id || k.type}`, label: k.label, icon: 'doc' });
  for (const s of q.sources) chips.push({ key: `source:${s}`, label: `from ${s}`, icon: 'globe' });
  for (const a of q.apps) chips.push({ key: `app:${a}`, label: a === 'AirDrop' ? 'via AirDrop' : `with ${a}`, icon: 'inbox' });
  if (q.time) chips.push({ key: 'time', label: q.time.label, icon: 'activity' });
  if (q.notOpenedDays) chips.push({ key: 'notOpened', label: q.notOpenedLabel, icon: 'activity' });
  if (q.size) chips.push({ key: 'size', label: q.size.label, icon: 'archive' });
  if (q.place) chips.push({ key: 'place', label: `in ${q.place.label}`, icon: 'folder' });
  if (q.inletAction) chips.push({ key: 'inlet', label: q.inletAction === 'moved' ? 'moved by Inlet' : 'removed', icon: 'undo' });
  for (const p of q.phrases) chips.push({ key: `phrase:${p}`, label: `mentions “${p}”`, icon: 'search' });
  for (const w of q.words) chips.push({ key: `word:${w}`, label: `“${w}”`, icon: 'search' });
  return chips;
}

/** Remove one chip's condition from a parsed query (when the person clicks its ✕). */
function withoutChip(q, key) {
  const next = JSON.parse(JSON.stringify(q));
  const [type, ...rest] = key.split(':');
  const val = rest.join(':');
  if (type === 'kind') next.kinds = next.kinds.filter((k) => (k.ext || k.id || k.type) !== val);
  if (type === 'source') next.sources = next.sources.filter((s) => s !== val);
  if (type === 'app') next.apps = next.apps.filter((a) => a !== val);
  if (type === 'time') delete next.time;
  if (type === 'notOpened') { delete next.notOpenedDays; delete next.notOpenedLabel; }
  if (type === 'size') delete next.size;
  if (type === 'place') next.place = null;
  if (type === 'inlet') next.inletAction = null;
  if (type === 'phrase') next.phrases = next.phrases.filter((p) => p !== val);
  if (type === 'word') next.words = next.words.filter((w) => w !== val);
  next.chips = chipsFor(next);
  return next;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isEmpty = (q) => !q.kinds.length && !q.sources.length && !q.apps.length && !q.time && !q.notOpenedDays && !q.size && !q.place && !q.inletAction && !q.phrases.length && !q.words.length;

module.exports = { parse, withoutChip, chipsFor, isEmpty, fmtDay, KIND_WORDS, APPS };
