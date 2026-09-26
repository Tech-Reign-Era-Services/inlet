'use strict';

const os = require('os');
const path = require('path');

// Extensions a browser uses while a download is still in progress. Never touch these.
const IN_PROGRESS_EXTENSIONS = [
  'crdownload', // Chrome, Edge, Brave, Arc
  'part', 'partial', // Firefox
  'download', // Safari (a bundle directory)
  'opdownload', // Opera
  'tmp', 'temp',
  'aria2', '!ut', 'bc!', 'filepart',
];

const DEFAULT_CATEGORIES = [
  { id: 'images', name: 'Images', icon: 'image', color: '#FF9F0A', folder: 'Images',
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'raw', 'cr2', 'nef', 'arw', 'dng'] },
  { id: 'documents', name: 'Documents', icon: 'doc', color: '#0A84FF', folder: 'Documents',
    extensions: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'md', 'pages', 'odt', 'tex', 'epub', 'mobi', 'vcf'] },
  { id: 'spreadsheets', name: 'Spreadsheets', icon: 'table', color: '#30D158', folder: 'Spreadsheets',
    extensions: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'numbers', 'ods'] },
  { id: 'presentations', name: 'Presentations', icon: 'slides', color: '#FF6B35', folder: 'Presentations',
    extensions: ['ppt', 'pptx', 'key', 'odp'] },
  { id: 'videos', name: 'Videos', icon: 'video', color: '#BF5AF2', folder: 'Videos',
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'] },
  { id: 'audio', name: 'Audio', icon: 'music', color: '#FF375F', folder: 'Audio',
    extensions: ['mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg', 'aiff', 'aif', 'opus', 'wma'] },
  { id: 'archives', name: 'Archives', icon: 'archive', color: '#AC8E68', folder: 'Archives',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'] },
  { id: 'installers', name: 'Installers', icon: 'box', color: '#64D2FF', folder: 'Installers',
    extensions: ['dmg', 'pkg', 'mpkg', 'app', 'iso', 'exe', 'msi'] },
  { id: 'code', name: 'Code & Data', icon: 'code', color: '#5E5CE6', folder: 'Code',
    extensions: ['js', 'jsx', 'ts', 'tsx', 'py', 'ipynb', 'json', 'jsonl', 'html', 'css', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'sh', 'yml', 'yaml', 'xml', 'sql', 'swift', 'kt', 'plist', 'sqlite', 'sqlite3', 'db', 'dump', 'parquet'] },
  { id: 'design', name: 'Design', icon: 'pen', color: '#FF2D92', folder: 'Design',
    extensions: ['psd', 'ai', 'sketch', 'fig', 'xd', 'indd', 'afdesign', 'afphoto', 'eps'] },
  { id: 'fonts', name: 'Fonts', icon: 'type', color: '#8E8E93', folder: 'Fonts',
    extensions: ['ttf', 'otf', 'woff', 'woff2'] },
  { id: 'keys', name: 'Keys & Certs', icon: 'key', color: '#FFD60A', folder: 'Keys & Certs',
    extensions: ['pem', 'p12', 'pfx', 'cer', 'crt', 'der', 'gpg', 'asc', 'keystore', 'jks', 'ovpn', 'mobileprovision'] },
].map((c) => ({ ...c, enabled: true }));

const OTHER_CATEGORY = { id: 'other', name: 'Other', icon: 'dots', color: '#98989D', folder: 'Other', extensions: [], enabled: true };

const DEFAULT_RULES = [
  {
    id: 'rule-screenshots', name: 'Screenshots', enabled: true, match: 'any',
    conditions: [
      { field: 'name', op: 'startsWith', value: 'Screenshot' },
      { field: 'name', op: 'startsWith', value: 'Screen Shot' },
    ],
    target: 'Images/Screenshots',
  },
  {
    id: 'rule-statements', name: 'Bank statements', enabled: false, match: 'any',
    conditions: [
      { field: 'name', op: 'contains', value: 'statement' },
      { field: 'name', op: 'contains', value: 'invoice' },
    ],
    target: 'Documents/Finance',
  },
  {
    id: 'rule-github', name: 'From GitHub', enabled: false, match: 'all',
    conditions: [{ field: 'source', op: 'contains', value: 'github.com' }],
    target: 'Code',
  },
];

function defaultSettings() {
  const downloads = path.join(os.homedir(), 'Downloads');
  return {
    version: 1,
    mode: 'manual',
    watchDir: downloads,
    autoDelaySec: 5,
    dateSubfolders: 'none', // 'none' | 'year' | 'year-month'
    unknownFiles: 'other', // 'other' | 'leave'
    folderPolicy: 'skip', // 'skip' | 'move'
    ignorePatterns: ['*.torrent'],
    notifications: true,
    schedule: { enabled: false, time: '18:00', days: [0, 1, 2, 3, 4, 5, 6], enabledAt: 0 },
    lastScheduledRun: 0,
    retentionDays: 30, // how long removed files stay undoable before going to the macOS Trash
    staleDays: 90,
    ledgerEnabled: true, // remember where files came from
    ledgerKeepDays: 730, // 0 = forever
    ledgerBackfilled: {}, // folder path → when its existing files were recorded (by path: the main folder's id never changes)
    syncFile: '', // optional shared rules file (e.g. in iCloud Drive)
    syncUpdatedAt: 0,
    lastSeenVersion: '',
    launchAtLogin: false,
    showDockIcon: true,
    shelfEnabled: true, // the Shelf at the top of the screen (the notch on Macs that have one)
    categories: JSON.parse(JSON.stringify([...DEFAULT_CATEGORIES, OTHER_CATEGORY])),
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
    onboarded: false,
    tourDone: false, // first-run guided tour shown (or skipped)
  };
}

module.exports = { IN_PROGRESS_EXTENSIONS, DEFAULT_CATEGORIES, OTHER_CATEGORY, DEFAULT_RULES, defaultSettings };
