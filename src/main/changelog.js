'use strict';

// Shown in "What's new" after an update (newest first). Keep entries short and user-facing.
module.exports = [
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
