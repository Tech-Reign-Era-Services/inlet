# Find: ask for files in plain English (plan)

Status: **Phase 1 (provenance ledger) built in 1.6.0.** Phases 2–5 are proposals. Research done 2026-09-25 on macOS 26.6.

## The goal

Let people find files the way they remember them, not by file name:

| They type | Inlet understands |
|---|---|
| pdfs I downloaded from github last week | kind = PDF · source = github.com · downloaded in the last 7 days |
| that invoice from amazon about the headphones | text contains "invoice", "headphones" · source = amazon |
| big videos I haven't opened in a month | kind = video · size > 100 MB · not opened in 30 days |
| screenshots from yesterday | kind = screenshot · created yesterday |
| the zip my manager sent on teams | kind = archive · downloaded with Microsoft Teams |
| what did Inlet move this morning | Inlet history · today before 12:00 |

Every result can be **grabbed**: opened, revealed, previewed, dragged out, or gathered into a folder. Gathering is an undoable move.

---

## What the research found

Checked on a real Mac with ~2,450 files in Downloads (counts only, no contents read).

| Source of information | What it gives | Coverage / availability | Notes |
|---|---|---|---|
| **Spotlight index** (`mdfind`) | Name, kind, type tree, size, dates (added, created, modified, **last opened**), **text inside files**, Finder tags, "where from" | Everything Spotlight indexes | Relative dates work natively (`$time.today(-7)`, `$time.this_week`). A text search across Downloads took **~2.4 s**. Doesn't cover unindexed or excluded folders, or files that landed seconds ago. |
| **"Where from"** (`kMDItemWhereFroms` extended attribute) | Download URL and the page it came from | **Only 11% of files** (279 of 2,456) | Lost when files are unzipped, AirDropped, saved from apps, or copied by some tools. |
| **Quarantine tag** (`com.apple.quarantine`) | **Which app** downloaded it (Safari, Chrome, AirDrop = `sharingd`, Teams, Notion…) and **when**, plus an event ID | **64% of files** (1,563) | Unzipped files **inherit the archive's ID**: 1,103 files share just 6 IDs. |
| **macOS download log** (`QuarantineEventsV2`) | Designed to map that ID to a URL | Readable, 560 events | **Every URL field is empty** on current macOS, so it can't recover sources. |
| **Chrome / Brave / Edge / Arc history** | Every download: saved path, site, page, referrer, time, type | Readable without special permission (Chrome: 48 downloads, Brave: 12 on this Mac) | Personal data: must be **opt-in**, read-only, and use the downloads table only. |
| **Safari downloads** (`~/Library/Safari/Downloads.plist`) | Same idea, for Safari | Needs **Full Disk Access** | Safari is the main browser on this Mac (1,368 quarantine tags), so it matters. Opt-in with a clear explanation. |
| **Inlet's own history** | Everything Inlet moved, renamed or removed, with the source website since 1.5 | Always | Can already answer "what did Inlet do…". |
| **Apple's on-device model** (Foundation Models, macOS 26) | Turns a sentence into structured filters, privately and offline | Only on macOS 26, Apple silicon, with **Apple Intelligence switched on**. It was **off** on the test Mac. | Needs full Xcode to build the helper (its `@Generable` macro isn't in the Command Line Tools). **Can't be required.** |

### What others do

- **Spotlight** understands a little natural language ("documents from last week"), but not "where from" in plain English, and it can't find files whose source info was lost.
- **HoudahSpot** exposes every Spotlight attribute, including "Downloaded file source", through a power-user criteria builder. There's no plain English.
- **Alfred, Raycast:** mainly search by name.
- **Dhito, Fenn** (paid): semantic search using local embeddings ("policy on remote work" finds the handbook). They index everything, and are strong on meaning but weak on provenance.

**The gap Inlet can own:** *"where did I get this?"* Nobody remembers where files came from after the source information is lost, and Inlet already watches files arrive.

---

## The key idea: Inlet remembers where files came from

A **provenance ledger**: a small local record Inlet writes the moment a file lands in a watched folder, while the information still exists.

For each file it stores:

- path, name, **inode + size** (to follow renames and moves; the same approach as `finder.js`)
- download URL, page URL and page title, and the **domain** (e.g. `github.com`)
- the app that downloaded it, and the time (from the quarantine tag)
- the **quarantine ID**. Anything later unzipped from this file carries the same ID, so extracted files inherit the archive's source. That turns the 6 untraceable families above (1,103 files) into traceable ones from now on.
- what Inlet did to it (sorted to, renamed to, removed), linked to history
- optionally, a match from browser history (see Phase 3)

Details:

- **Backfill on first run:** read "where from" and quarantine tags for existing files, so the ledger isn't empty on day one.
- **Storage:** `~/Library/Application Support/Inlet/ledger.jsonl` (append-only, about 300 bytes per file; 10,000 files ≈ 3 MB). No new dependencies.
- **Never shared:** excluded from rules export and sync. You can view, export or clear it in Settings.
- **Also useful elsewhere:** a "Downloaded from" line in Organize and Activity, and more reliable website rules.

---

## Understanding the request

Three layers. The first always works.

1. **Built-in parser (every Mac, offline, instant).** A small hand-written grammar in `src/main/find/parse.js`:
   - **kinds:** Inlet's category names and synonyms ("photos" → Images, "installers", "slides"), extensions ("pdfs", ".zip"), Finder kinds, and "screenshots"
   - **time:** today, yesterday, this/last week or month, "in March", "3 days ago", "since Monday", "before 2025", plus which date ("downloaded", "opened", "changed")
   - **source:** "from github", "on amazon", "github.com", "that X sent" (AirDrop sender)
   - **app:** "in Chrome", "via AirDrop", "from Teams", "Slack"
   - **text:** "about X", "mentioning X", "that says X", quoted phrases
   - **size:** "big", "huge", "over 50 MB", "small"
   - **state:** "haven't opened", "Inlet moved", "I removed", "duplicates"
   - **place:** "on my desktop", "in Documents"

   Words left over are searched in names *and* text. The parser returns a **Query object**, and a confidence score.

2. **Optional Apple on-device model** (macOS 26 + Apple silicon + Apple Intelligence on). A tiny bundled Swift helper, built in CI with Xcode, turns the sentence into the *same* Query object. Inlet uses it only when the parser isn't confident, and never needs it.

   *Tested 2026-09-25 with Apple Intelligence on (macOS 26.6): about 1 s per request (4 s for the first). It got the gist of every request, but made up details: "last 10 days" and "over 5 MB" for an invoice request that said neither, and it called a zip an "installer". So keep any field only if the sentence contains evidence for it, prefer the parser when they disagree, and use guided generation (`@Generable`, built with Xcode in CI) rather than free-form JSON.*

3. **Show the interpretation as editable chips.** For example: `PDF` `from github.com` `last 7 days` ✕. People see what Inlet understood, and fix it with a click. There's no black box.

**Not planned:** a cloud AI. It would break Inlet's "no network" promise. If there's demand, it could come later as an opt-in with your own API key, off by default.

---

## Finding: one query, several sources

```
sentence ─► parser (+ optional on-device model) ─► Query ─► planner ─┬─► Spotlight (mdfind, scoped)
                                                                     ├─► provenance ledger
                                                                     ├─► Inlet history
                                                                     ├─► browser download history (opt-in)
                                                                     └─► direct scan (unindexed folders)
                                    results ◄─ merge by inode · rank · "why it matched" ◄┘
```

- **Planner:** compiles the Query into a Spotlight query string, e.g. `kMDItemContentTypeTree == "com.adobe.pdf" && kMDItemDateAdded >= $time.today(-7)`, plus ledger and history filters. A source filter checks *both* Spotlight's "where from" and the ledger.
- **Scope:** by default, watched folders and Inlet's own folders. There's an **Everywhere on this Mac** toggle (the home folder, excluding Library).
- **Speed:** metadata results in under 1 s, text results stream in (about 2–3 s). A new keystroke cancels the old search.
- **"Why it matched"** under every result, e.g. "from github.com · downloaded 4 days ago in Safari · mentions *invoice* on page 2".
- **Honest gaps:** when a source can't be known, say so. For example: "Inlet started remembering sources on 25 Sep. 40 older PDFs have no source; connect Chrome's download history to check them."

---

## Grabbing results

| Action | Notes |
|---|---|
| Open · Show in Finder · Quick Look (Space) · Copy path · drag out | Basics |
| **Gather into a folder** | Moves the selected files into a new folder. Recorded in history, so it's undoable. |
| Tidy selected · Remove | Reuses the existing sort and holding-folder actions |
| **Save as Smart Folder** | Writes a Finder `.savedSearch` from the Spotlight part of the query, so it lives in Finder too |
| **Make a rule from this search** | "Always send PDFs from github.com to Code". Reuses the rule editor. |

---

## Interface

- A new **Find** page in the sidebar, and a **menu bar quick panel** with a global shortcut (⌥⌘F by default, and configurable).
- A big search box with example prompts ("try: *pdfs from github last week*"), chips under it, and results grouped by day with thumbnails.
- Keyboard first: ↑/↓ to move, ⏎ to open, ⌘⏎ to reveal, Space for Quick Look, ⌘A then G to gather.

---

## Privacy and permissions

- **Everything stays on the Mac.** No network, as today.
- **Browser history is opt-in, per browser.** Inlet reads a *copy* of the downloads table only, never page-visit history, and says exactly what it reads.
- **Safari's history needs Full Disk Access.** Explain why, and link to the setting. Everything else works without it.
- **You're in control of the ledger:** view it, export it, or clear it, and choose how long to keep it (default 2 years).

---

## Phases

| Phase | What ships | Visible result |
|---|---|---|
| **1. Provenance ledger** ✅ 1.6.0 | Record on arrival (auto mode, scans, Organize), backfill, quarantine-ID families for unzipped files, "Downloaded from" in Organize and Activity, ledger controls in Settings | Inlet starts remembering where files came from |
| **2. Find (built-in)** | Parser, planner, Spotlight + ledger + history sources, Find page, chips, "why it matched", open/reveal/gather (undoable) | Plain-English search on every Mac |
| **3. More sources and actions** | Opt-in Chrome, Brave, Edge and Arc import, and Safari with Full Disk Access; Smart Folder export; rule from search; menu bar quick panel with shortcut | Finds sources for older files; search from anywhere |
| **4. On-device model** | Swift helper built in CI, used when the parser is unsure; a test set of 150 real phrasings with a target of ≥ 90% correct | Handles messier sentences on Apple Intelligence Macs |
| **5. Research** | "Search by meaning" with on-device embeddings (Apple's NaturalLanguage framework); decide based on Phase 2–4 feedback | Maybe |

Phases 1 and 2 are the minimum useful version. Phase 1 should ship first even on its own, because every day without it is a day of sources that can never be recovered.

---

## Testing

- **Parser:** a table of 150+ phrases, each with its expected Query (golden tests). Community issues can add phrases that failed.
- **Planner:** Query → exact Spotlight query string.
- **Ledger:** rename, move, unzip (the child inherits the archive's source), remove and undo, backfill, in temporary folders like the existing tests.
- **End to end:** a sandbox with files carrying fake "where from" and quarantine tags, run with `INLET_WATCH_DIR`.
- **Privacy check:** a test that fails if anything in `src/` opens a network connection.

---

## Decisions for you

1. **Default scope:** watched folders only, or the whole home folder?
2. **Browser history:** OK to offer the opt-in import in Phase 3? (Recommended: yes, off by default.)
3. **Name:** "Find", "Ask Inlet", or "Where is…"?
4. **How long to keep the ledger:** 2 years by default?
5. **Phase 1 first**, before any search interface? (Recommended: yes. It starts collecting data that can't be recovered later.)
