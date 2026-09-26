# Inlet — a Downloads organizer for macOS

*Formerly “Tidy”. It was renamed because another Mac app in the same category already uses that name.*

Inlet keeps `~/Downloads` clean by sorting files into category folders. It has two modes:

- **Auto mode**: a file is sorted as soon as it finishes downloading.
- **Manual mode**: Inlet shows a preview of what it would move. Nothing moves until you click **Tidy now**.

Built with Electron and a plain HTML/CSS/JS UI. It has no native code and no runtime dependencies.

---

## 1. What's already on the market

| Tool | Platform / price | What it does well | Where it falls short |
|---|---|---|---|
| **Hazel** (Noodlesoft) | macOS, ~$42 | Powerful rule engine that can match on name, kind, date, *source URL*, and contents. Manages the Trash. Rule preview. | Hard to learn. The rule UI feels like a 2010 System Preferences pane. It is overkill for "just keep Downloads tidy". |
| **Folder Tidy** | macOS App Store, ~$5 | One-click tidy by file type. Custom rules. Undo. | Manual only, with no background watching. Basic UI. |
| **Declutter / Downloads Organizer** style apps | macOS App Store | Lives in the menu bar and sorts by extension on a schedule. | Only matches on extension. Weak or missing undo. Little visibility into what happened. |
| **CleanMyMac** | macOS, subscription | Finds large and old files, duplicates, and uninstaller leftovers. | A cleaner, not an organizer. It deletes things; it doesn't sort them. |
| **DropIt / File Juggler** | Windows | Rule-based sorting with filters and "monitor folder". | Windows only. |
| **organize** (Python), **Maid** (Ruby) | CLI, free | Rules written as code or YAML. Simulate/dry-run mode. | Developers only. No UI. |

**Features users expect, based on those tools:** sorting by type, custom rules, background watching, a menu bar presence, and undo.

**Gaps Inlet fills:**

1. **Safe auto mode.** Many tools grab a file while it is still downloading. Inlet ignores in-progress files (`.crdownload`, `.part`, `.download`, `.opdownload`, …) and waits until a file's size has stopped changing before moving it.
2. **Preview before you commit.** Manual mode is a dry run first: see every file, its target folder, and *why* (which rule matched). Change the target of any single file before clicking go.
3. **Source-aware rules (Hazel's best feature, made simple).** macOS records where each file was downloaded from (`kMDItemWhereFroms`). Inlet can sort by website, for example "anything from `github.com` → Code" or "anything from `mybank.com` → Finance".
4. **Every action can be undone.** Each batch is logged. Undo a whole batch or a single file from the Activity page.
5. **Sensitive-file awareness.** Keys, certificates, and credential JSONs are common in a developer's Downloads. They go into their own **Keys & Certs** folder instead of being mixed in with documents.
6. **A modern, native-feeling UI.** Vibrancy sidebar, light and dark mode, real Finder file icons, and a menu bar item.

---

## 2. Features (v1 — this build)

### Modes
- **Manual** (default on first launch, the safe choice). Dashboard shows *N unsorted files*. **Organize** page shows the full preview, with a checkbox and category override on each row. The **Tidy now** button is also in the menu bar.
- **Auto**. Watches the folder with macOS FSEvents (`fs.watch`). When a file changes, Inlet waits for a configurable settle delay (default 5s) and checks that the size is stable. Then it classifies and moves the file and shows a batched notification ("Sorted 3 files").

### Classification pipeline (first match wins)
1. **Ignore checks**: hidden files, in-progress downloads, user ignore patterns, and Inlet's own destination folders.
2. **Custom rules**, in the user's order. Conditions can match on *name*, *extension*, *source URL/domain*, *size*, or *age*, combined with ALL or ANY. The target is a category or any folder.
3. **Categories by extension**: Images, Documents, Spreadsheets, Presentations, Videos, Audio, Archives, Installers, Code, Design, Fonts, Keys & Certs.
4. **Fallback**: send unknown files to *Other*, or leave them in place (a setting).

**Folders** in Downloads are skipped by default, because they may be projects. Package files such as `.app`, `.pages`, and `.numbers` are treated as files.

### Destinations
- Each category has a folder. A relative path resolves inside Downloads (for example `Downloads/Images`); an absolute path can point anywhere (for example `~/Pictures/From Downloads`).
- Optional date subfolders: `Images/2026` or `Images/2026-09`.
- Name conflicts never overwrite. The file is renamed to `report (1).pdf`.
- Moves across volumes fall back to copy, verify, then delete.

### Activity & undo
- Every move is recorded with its trigger (auto or manual) and the rule that matched.
- Undo a batch or a single file. Undo refuses to overwrite anything that now sits at the original path.

### App shell
- Menu bar (tray) item: current mode, a toggle, *Tidy now*, the unsorted count, *Open Inlet*, and *Quit*.
- Closing the window keeps Inlet running in the menu bar so auto mode keeps working.
- Launch at login. Option to hide the Dock icon.

### Screens
1. **Overview**: Auto/Manual mode switch, unsorted count and size, breakdown by category, big **Tidy now** button, recent activity, and all-time stats.
2. **Organize**: preview table with real file icons, target category, the reason it matched, and select/override controls. Search and category filter. Reveal in Finder.
3. **Rules**: category cards (extensions as editable chips, destination, on/off) and a custom rule builder with a live "matches N files right now" count.
4. **Activity**: timeline of batches with per-batch and per-file undo.
5. **Settings**: watched folder, settle delay, date subfolders, unknown-file and folder policy, ignore patterns, notifications, launch at login, Dock icon, reset.

---

## 3. Architecture

```
src/
  main/
    main.js         app lifecycle, window, tray, IPC wiring, notifications
    store.js        settings + history persistence (JSON in ~/Library/Application Support/Inlet)
    defaults.js     default categories, rules, settings
    classifier.js   pure: file info + settings → decision {category, target, reason} | skip
    organizer.js    scan → plan (dry run) → execute moves → undo; conflict-safe, cross-volume safe
    watcher.js      auto mode: FSEvents watch, debounce, in-progress + size-stability checks
    source.js       reads the download source URL from the com.apple.metadata:kMDItemWhereFroms xattr
    tray.js         menu bar item
  preload.js        contextBridge API (the only way the renderer reaches the main process)
  renderer/
    index.html, styles.css, app.js, icons.js
scripts/
  make-icons.js     generates the app icon and tray template PNGs (no image tools needed)
test/
  organizer.test.js node:test against a temp folder (classification, conflicts, undo, in-progress skip)
```

**Why this shape:** `classifier`, `organizer`, and `watcher` don't import Electron, so they can be unit-tested with `node --test`. The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node, strict CSP) and can only call a small, named API.

**Security & safety rules**
- Inlet never deletes user files. It only moves them, and every move can be undone.
- Inlet never overwrites. Conflicts are renamed.
- Inlet never touches folders unless the user opts in, and never touches its own destination folders.
- Manual mode is the default. The user has to switch auto mode on.

---

## 4. Roadmap (after v1)

| Phase | Feature | Status |
|---|---|---|
| v1.1 | Scheduled tidy (for example daily at 6pm) as a middle ground between auto and manual. | ✅ Done |
| v1.1 | Rename actions with tokens: `{name}`, `{date}`, `{year}`, `{month}`, `{source}`. | ✅ Done |
| v1.1 | Undo everywhere: ⌘Z, "Undo last" in the menu bar, Activity and Overview. | ✅ Done |
| v1.2 | **Stale files**: files not opened (Spotlight last-used date) in N days. Archive them to `Old Downloads/<year>` or remove them. | ✅ Done |
| v1.2 | **Duplicates finder** (size, then SHA-256). Keeps the plain name (`report.pdf` over `report (1).pdf`). | ✅ Done |
| v1.2 | **Undoable removal**: removed files go to a hidden `.Inlet Removed` holding folder for 30 days, then to the macOS Trash. (`~/.Trash` is protected by macOS privacy controls, so an app can't reliably take files back out of it. The holding folder is what makes undo dependable.) | ✅ Done |
| v1.3 | Watch several folders (Desktop, screenshots folder). Each sorts in place or into Downloads' folders. Nested and whole-home folders are refused. | ✅ Done |
| v1.3 | Content rules: Finder kind (`kMDItemKind`) and file text. Text comes from `mdimport -t` rather than `mdfind`, because freshly downloaded files and unindexed folders aren't in Spotlight's index yet. Text is only read while a content rule is on. | ✅ Done |
| v1.4 | Per-folder mode (e.g. Auto for Desktop, Manual for Downloads) and per-folder rules. | ✅ Done |
| v1.4 | Suggested rules learned from Organize corrections. A suggestion needs 2+ files agreeing at least 80% of the time; taking an extension from another category needs 5. Accepting can be undone, dismissing is remembered. | ✅ Done |
| v1.5 | Learn from files moved by hand in Finder: into another Inlet folder counts as a correction (feeds suggestions), back into Downloads means auto mode leaves it alone. | ✅ Done |
| v1.5 | Unsigned DMG (`npm run dist`) with install instructions. | ✅ Done |
| v1.7 | One universal installer (`.pkg`, Apple silicon + Intel) with welcome, license and summary pages; opens Inlet when done. | ✅ Done |
| — | Signed and notarized DMG, and auto-update. | ⏸ On hold: needs an Apple Developer account ($99/yr). Auto-update on macOS requires a signed app, so it's on hold too. |
| v2 | In-app release notes (What's new); rule sync between Macs through a shared file (iCloud Drive/Dropbox), plus export/import. | ✅ Done |

---

## 5. Running

```bash
npm install
npm start            # run in dev
npm test             # unit tests (no Electron needed)
npm run dist         # build the universal .pkg installer (unsigned)
```
