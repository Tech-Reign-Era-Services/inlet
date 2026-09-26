# Security policy

Inlet moves files on people's Macs, so we take problems that could lose, expose or misplace files seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/Tech-Reign-Era-Services/inlet/security) → **Report a vulnerability**.
2. Describe what happens, how to reproduce it, and which version of Inlet and macOS you're using.

Only the maintainers can see your report. We aim to reply within 7 days, keep you updated, and credit you in the release notes unless you'd prefer not to be named.

## What counts

For example:

- Inlet deleting, overwriting or losing a file, or moving one somewhere it shouldn't
- A crafted file name, rules file or sync file that makes Inlet run code or touch files outside the folders it manages
- The interface being able to reach more than the functions in `src/preload.js`
- Inlet sending anything over the network

A bug that sorts a file into the wrong category, but loses nothing, is an ordinary [bug report](https://github.com/Tech-Reign-Era-Services/inlet/issues/new/choose).

## Supported versions

Only the latest release gets fixes. Please update before reporting.

## About unsigned builds

The release installer isn't signed with an Apple Developer certificate yet, which is why macOS asks you to confirm the first time you open it. Only download Inlet from this repository's [Releases](https://github.com/Tech-Reign-Era-Services/inlet/releases) page, or build it yourself from source.
