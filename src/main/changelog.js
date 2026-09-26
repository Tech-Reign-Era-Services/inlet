'use strict';

// Shown in "What's new" after an update (newest first). Keep entries short and user-facing.
module.exports = [
  {
    version: '1.9.1',
    title: 'Shelf fixes',
    items: [
      'Drag a file towards the notch and the Shelf now opens before you reach it, so there’s room to drop. Before, you had to land exactly on the notch.',
      'Whatever you’re dragging now stays in front of the Shelf instead of disappearing behind it.',
      'Space previews and closes reliably every time. ← → and clicking another item show that item, not the one you started with.',
    ],
  },
  {
    version: '1.9.0',
    title: 'Updates, right in the app',
    items: [
      'Inlet now tells you when a new version is out, with what’s new, in a card in the sidebar and in the menu bar.',
      'Click Update: Inlet downloads the installer, checks it matches the release on GitHub, and opens it. Your settings, rules and history are kept.',
      'Not now? Choose Later, or Skip this version. Or check any time with Inlet → Check for Updates….',
      'The only thing Inlet asks the internet is whether there’s a new version. Nothing about you or your files is sent. Turn it off in Settings → Updates.',
    ],
  },
  {
    version: '1.8.0',
    title: 'The Shelf',
    items: [
      'A place at the top of your screen to keep things for a moment. Drop files, folders, text or links on the notch (or the middle of the menu bar on a Mac without one).',
      'Then drag them out one at a time, or several at once, wherever they need to go. Or select them, press ⌘C, and ⌘V anywhere pastes the files themselves.',
      'Hover over the notch to open the Shelf, or press ⌃⌥S from any app. With the Shelf open, ⌘V adds whatever you copied.',
      'Press Space to preview an item with Quick Look, and ← → to flip through them, just like in Finder.',
      'Files stay where they are: the Shelf only points to them. It keeps its contents when you quit, and you can turn it off in Settings.',
      'Found something with Find? Select it and choose Add to Shelf.',
    ],
  },
  {
    version: '1.7.0',
    title: 'Find files by describing them',
    items: [
      'New Find page (⌘F). Type what you remember, like “pdfs from github last week” or “big videos I haven’t opened in a month”.',
      'Inlet shows what it understood as chips. Remove any of them to widen the search.',
      'Every result says why it matched, and where the file came from.',
      'Select results to gather them into a folder (undoable), copy their paths, or show them in Finder. Space previews a file, and you can drag files out.',
      'Code projects are left out unless you ask, so searches stay fast.',
      'One installer for every Mac: Apple silicon and Intel. It walks you through the install and opens Inlet when it’s done.',
    ],
  },
  {
    version: '1.6.0',
    title: 'Inlet remembers where files came from',
    items: [
      'Inlet now notes which website and app each download came from, the moment it arrives, even in Manual mode.',
      'Files you unzip keep the website of the archive they came from. macOS forgets that; Inlet doesn’t.',
      'See where a file came from by hovering over it in Organize, and in Activity.',
      'Website rules now work for unzipped files too.',
      'Settings → Download history: see what’s recorded, choose how long to keep it, export it, or clear it. It never leaves your Mac.',
    ],
  },
  {
    version: '1.5.1',
    title: 'Tidy is now Inlet',
    items: [
      'New name, same app. Another Mac app is already called Tidy.',
      'Your settings, rules, history and removed files came across automatically.',
      'Rules files saved by Tidy still import and sync.',
    ],
  },
  {
    version: '1.5.0',
    title: 'Inlet learns from Finder',
    items: [
      'If you drag a sorted file into a different Inlet folder, Inlet counts it as a correction and may suggest a rule.',
      'Drag a file back out into Downloads and auto mode leaves it there.',
      'Export and import your rules, or keep them in sync between Macs with a shared file (e.g. in iCloud Drive).',
      'This “What’s new” window.',
      'A quick guided tour for new users. Take it any time from Help → Take the Tour.',
      'Hover over any icon to see what it does.',
    ],
  },
  {
    version: '1.4.0',
    title: 'Per-folder mode and suggested rules',
    items: [
      'Each watched folder can be always Auto, always Manual, or follow Inlet’s mode.',
      'Rules can apply to specific folders only.',
      'Inlet suggests rules from the destinations you pick by hand in Organize.',
    ],
  },
  {
    version: '1.3.0',
    title: 'More folders, smarter rules',
    items: [
      'Watch Desktop or any folder alongside Downloads.',
      'Rules can match a file’s kind or the text inside it.',
    ],
  },
  {
    version: '1.2.0',
    title: 'Cleanup',
    items: [
      'Find files you haven’t opened in months and archive or remove them.',
      'Find duplicate files and remove the extra copies.',
      'Removed files wait 30 days in a holding folder, so you can undo.',
    ],
  },
  {
    version: '1.1.0',
    title: 'Schedules and renaming',
    items: ['Inlet on a schedule.', 'Rename files as rules move them.', '⌘Z undoes Inlet’s last action.'],
  },
];
