'use strict';

// Learns from the destinations people pick by hand in Organize and proposes rules for them.
// Pure functions over a small learning log, so they're easy to test.
const path = require('path');

const MAX_EVENTS = 500;
const MIN_COUNT = 2; // distinct files before we suggest anything
const MIN_COUNT_TO_RECLAIM = 5; // to move an extension another category already claims
const MIN_SHARE = 0.8; // of corrections involving that signal, this many must agree on the destination

// Words that say nothing about where a file belongs.
const STOPWORDS = new Set(['copy', 'final', 'file', 'files', 'image', 'img', 'document', 'doc', 'untitled', 'download', 'downloads',
  'new', 'old', 'version', 'draft', 'the', 'and', 'for', 'with', 'from', 'screen', 'shot', 'screenshot', 'photo', 'scan', 'export']);

const extOf = (name) => path.extname(name).slice(1).toLowerCase();

function wordsOf(name) {
  const base = path.parse(name).name.toLowerCase();
  return [...new Set(base.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w)))];
}

/** Remember a manual correction: Inlet wanted `fromCat`, the person chose `toCat`. */
function record(learning, corrections) {
  const now = Date.now();
  for (const c of corrections) {
    if (!c.toCat || c.toCat === c.fromCat) continue;
    learning.events.push({ name: c.name, ext: extOf(c.name), host: c.host || '', words: wordsOf(c.name), fromCat: c.fromCat, toCat: c.toCat, folderId: c.folderId || 'primary', time: now });
  }
  if (learning.events.length > MAX_EVENTS) learning.events.splice(0, learning.events.length - MAX_EVENTS);
  return learning;
}

/** Group events by a signal value; keep values where enough distinct files agree on one destination. */
function consistent(events, signalOf) {
  const bySignal = new Map();
  for (const e of events) {
    for (const v of [].concat(signalOf(e) || [])) {
      if (!v) continue;
      if (!bySignal.has(v)) bySignal.set(v, []);
      bySignal.get(v).push(e);
    }
  }
  const out = [];
  for (const [value, list] of bySignal) {
    const counts = new Map();
    for (const e of list) {
      if (!counts.has(e.toCat)) counts.set(e.toCat, new Set());
      counts.get(e.toCat).add(e.name);
    }
    const total = new Set(list.map((e) => e.name)).size;
    for (const [toCat, names] of counts) {
      if (names.size >= MIN_COUNT && names.size / total >= MIN_SHARE) out.push({ value, toCat, count: names.size, examples: [...names].slice(0, 3) });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

const hasRule = (settings, field, value, target) => settings.rules.some((r) => r.target === target
  && (r.conditions || []).some((c) => c.field === field && String(c.value).toLowerCase() === value));

/**
 * Suggestions not yet applied or dismissed. Each has an id (stable key), a human title/detail,
 * examples, and an `apply` description the main process knows how to carry out.
 */
function suggestions(learning, settings) {
  const cat = (id) => settings.categories.find((c) => c.id === id);
  const dismissed = new Set(learning.dismissed || []);
  const out = [];

  for (const s of consistent(learning.events, (e) => e.ext)) {
    const c = cat(s.toCat);
    if (!c || c.id === 'other' || c.extensions.includes(s.value)) continue;
    // Taking an extension away from another category (e.g. all PDFs) needs much stronger evidence
    // than claiming one nobody handles yet — a couple of bank statements aren't a rule for every PDF.
    const claimed = settings.categories.some((x) => x.id !== c.id && x.extensions.includes(s.value));
    if (claimed && s.count < MIN_COUNT_TO_RECLAIM) continue;
    out.push({
      id: `ext:${s.value}->${c.id}`, kind: 'extension', categoryId: c.id,
      title: `Always sort .${s.value} files into ${c.name}?`,
      detail: `You moved ${s.count} .${s.value} files there by hand.`,
      examples: s.examples, apply: { type: 'extension', ext: s.value, categoryId: c.id },
    });
  }

  for (const s of consistent(learning.events, (e) => e.host)) {
    const c = cat(s.toCat);
    if (!c || hasRule(settings, 'source', s.value, c.folder)) continue;
    out.push({
      id: `host:${s.value}->${c.id}`, kind: 'rule', categoryId: c.id,
      title: `Send downloads from ${s.value} to ${c.name}?`,
      detail: `${s.count} files from ${s.value} ended up in ${c.name} after you changed them.`,
      examples: s.examples,
      apply: { type: 'rule', rule: { name: `From ${s.value}`, match: 'all', conditions: [{ field: 'source', op: 'contains', value: s.value }], target: c.folder } },
    });
  }

  for (const s of consistent(learning.events, (e) => e.words).slice(0, 5)) {
    const c = cat(s.toCat);
    if (!c || hasRule(settings, 'name', s.value, c.folder)) continue;
    out.push({
      id: `word:${s.value}->${c.id}`, kind: 'rule', categoryId: c.id,
      title: `Move files named “${s.value}” to ${c.name}?`,
      detail: `You picked ${c.name} for ${s.count} files with “${s.value}” in the name.`,
      examples: s.examples,
      apply: { type: 'rule', rule: { name: `“${s.value}” files`, match: 'all', conditions: [{ field: 'name', op: 'contains', value: s.value }], target: c.folder } },
    });
  }

  return out.filter((s) => !dismissed.has(s.id));
}

/** Apply a suggestion to settings. Returns a settings patch (and never mutates the input). */
function applySuggestion(settings, suggestion) {
  const a = suggestion.apply;
  if (a.type === 'extension') {
    return {
      categories: settings.categories.map((c) => (c.id === a.categoryId
        ? { ...c, extensions: [...new Set([...c.extensions, a.ext])] }
        : { ...c, extensions: c.extensions.filter((e) => e !== a.ext) })),
    };
  }
  const rule = { id: `rule-${Date.now()}`, enabled: true, folders: [], ...a.rule };
  return { rules: [...settings.rules, rule] };
}

module.exports = { record, suggestions, applySuggestion, wordsOf };
