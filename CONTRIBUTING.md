# Contributing to Inlet

Thanks for helping make Inlet better. You don't need to write code to contribute. Bug reports, testing on your Mac, and better wording in the app all count.

## Ways to help

| You want to… | Do this |
|---|---|
| Ask a question or get help | Start a [Discussion](https://github.com/Tech-Reign-Era-Services/inlet/discussions) in **Q&A** |
| Suggest an idea | Start a [Discussion](https://github.com/Tech-Reign-Era-Services/inlet/discussions) in **Ideas**. If it gets support, a maintainer turns it into an issue. |
| Report a bug | Open a [bug report](https://github.com/Tech-Reign-Era-Services/inlet/issues/new/choose) |
| Report a security problem | **Don't open an issue.** See [SECURITY.md](SECURITY.md). |
| Fix a bug or build a feature | Read on |

Issues labelled [`good first issue`](https://github.com/Tech-Reign-Era-Services/inlet/labels/good%20first%20issue) are small and well-defined. [`help wanted`](https://github.com/Tech-Reign-Era-Services/inlet/labels/help%20wanted) means maintainers would welcome a pull request.

## Before you write code

- **Small fixes** (typos, clear bugs, wording): just open a pull request.
- **Anything bigger** (new features, new settings, changed behavior): comment on the issue, or open one, first. Say how you plan to do it. This avoids spending a weekend on something that doesn't fit, and lets a maintainer point you at the right part of the code.
- **New dependencies:** Inlet has no runtime dependencies on purpose. Ask first before adding one.

## Set up

You need a Mac, [Node.js](https://nodejs.org) 20 or later, and git.

```bash
git clone https://github.com/<you>/inlet.git   # your fork
cd inlet
npm install
npm test        # should pass before you change anything
npm start       # run the app
```

**Don't test on your real Downloads folder.** Run a sandbox with its own settings. It can run alongside your installed Inlet:

```bash
mkdir -p /tmp/fake-downloads && cp ~/Desktop/*.png /tmp/fake-downloads/   # or any sample files
INLET_WATCH_DIR=/tmp/fake-downloads INLET_DATA_DIR=/tmp/inlet-data npm start
```

In a terminal inside VS Code, run `unset ELECTRON_RUN_AS_NODE` first, or Electron starts as plain Node.

## How the code is organised

- `src/main/`: everything that touches files. It's plain Node.js with no Electron, so it's tested directly. The README has a map of what each file does.
- `src/main/main.js`: the Electron shell (window, menu bar, notifications) and the bridge to the interface.
- `src/preload.js`: the **only** functions the interface can call. Keep this list small and explicit.
- `src/renderer/`: the interface, in plain HTML, CSS and JavaScript with no framework and no build step.
- `test/`: `node --test` tests for `src/main/`.

## Ground rules

These keep people's files safe. Pull requests that break them won't be merged.

1. **Never delete a file.** Inlet moves files. "Remove" means moving to the hidden holding folder, which is undoable, and only later to the macOS Trash.
2. **Never overwrite.** Name clashes become `name (1).ext`. Use `uniqueDest()` in `organizer.js`.
3. **Everything is undoable.** Any new action that moves files must be recorded in history, so Activity, ⌘Z and the menu bar can undo it.
4. **Leave folders and half-finished downloads alone** unless the user opted in.
5. **No network, no tracking.** The one exception is the update check in `src/main/updates.js`: it asks GitHub for the latest release, sends nothing about the user, and can be turned off. New code mustn't add any other network requests.
6. **Stay safe in the interface.** File names are untrusted: build elements with `h()`/`textContent`, never `innerHTML`. Keep `contextIsolation`, `sandbox` and the content security policy as they are.
7. **Manual mode stays the default.** Nothing should move on its own until the user turns on Auto mode or a schedule.

## Style

- Match the code around you. Plain modern JavaScript, CommonJS in `src/main/`, 2-space indentation, single quotes, semicolons.
- Explain *why* in comments, not *what*.
- The interface speaks plainly to people who aren't developers: "Removed 3 files", not "3 files purged from holding directory". Name buttons after what they do.
- New colours go in the CSS variables at the top of `styles.css`, and must work in both light and dark mode.

## Tests

- Changes to `src/main/` need a test in `test/`. A bug fix should come with a test that fails without it.
- Tests must use a temporary folder (`fs.mkdtempSync`), never your real folders.
- Interface changes: attach before and after screenshots to the pull request. `INLET_SCREENSHOTS=/tmp/shots npm start` captures every page.

## Pull requests

1. Fork the repository and create a branch from `main` (`fix-duplicate-names`, `feature-weekly-schedule`).
2. Keep a pull request to one change. Several small ones are easier to review than one large one.
3. Make sure `npm test` passes. GitHub runs the tests on every pull request too.
4. Fill in the pull request template. If the change is visible to users, add a line to the next version's entry in `src/main/changelog.js`. That text appears in the app's "What's new" window, so write it for users.
5. A maintainer will review it, usually within a week. Expect questions: they're about making the change safe for everyone's files, not a judgement of you.

Maintainers squash-merge, so your commit history in a pull request doesn't need to be tidy.

## Releases

Only maintainers publish releases (see "Releasing" in the README). Contributors don't need to change the version number.

## License

Inlet is [MIT licensed](LICENSE). By opening a pull request, you agree that your contribution is released under the same license.

## Code of conduct

Everyone taking part agrees to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, assume good intent, and keep feedback about the work.
