# YouTube-Comment-Image

A desktop app that makes a picture of a YouTube **live-chat comment**: type a name and a message and it
renders the comment exactly as YouTube's live chat does, then exports it as a PNG that matches a
Snipping Tool screenshot of that comment.

## Quick start

```sh
npm install
npm start
```

Requires Node.js 22.12 or newer. Always launch through `npm start` (or `node scripts/electron.js .`):
the launcher removes `ELECTRON_RUN_AS_NODE`, which some tools (e.g. VS Code extensions) set and which
would otherwise make Electron run as plain Node.

## What you can set

- **Name and message**: the name is shown exactly as typed (YouTube shows `@handles`, and some older
  accounts still show a display name). Emoji in the message are drawn with the same Noto emoji images
  YouTube uses (downloaded on demand; without internet they fall back to your system's emoji font, and the
  preview says so).
- **Avatar**: a YouTube-style default avatar (a coloured square with the first letter, shown as a circle),
  or any picture: choose a file or drop it on the window. Like YouTube, the app draws avatars from a 32 px
  image at up to 1.33× scale and from a 64 px one above that. **None** crops the avatar out, as if your
  snip started just right of it: the image begins where the avatar ended and the line breaks don't change.
- **Role**: viewer, member (green name, plus your channel's badge image if you add one; YouTube has no
  stock member badge), moderator (blue name with the shield badge, or YouTube's classic wrench badge with
  its older blue) or owner (highlighted name), plus a verified tick.
- **Theme**: dark or light chat.
- **Timestamp**: hidden by default, as in YouTube's live chat; it follows the clock until you edit it.
- **Comment width**: line breaks depend on how wide the chat is. YouTube's standard chat gives 385 px rows;
  wider windows and theater mode give wider rows (the saved page this was built from had 400 px, the
  default). Adjust it until the line breaks match what you see on YouTube.
- **Margin**: extra chat background around the comment, like a looser snip.
- **Scale**: defaults to your display's scale factor, which is what a screenshot of your screen contains.
  Pick 1×, 1.5×, 2×… for other sizes.

Export with **Save PNG…** (Ctrl+S) or **Copy image** (Ctrl+Shift+C).

## How it stays faithful

The comment is real YouTube markup styled by YouTube's own CSS, not an imitation:

- `src/comment/render.js` builds the same DOM YouTube's chat produces (elements, classes, attributes,
  even the zero-width spaces between the name and the message).
- `src/styles/youtube-chat.css` is the part of YouTube's chat stylesheet that applies to a message row,
  with its colour variables resolved for the dark and light themes; `src/styles/roboto.css` loads the
  same Roboto v48 font files YouTube's chat uses (bundled in `src/assets/fonts`).
- `src/stage/stage.html` reproduces the chat page around the row. The editor previews it, and export
  captures that same page from Chromium's compositor at the chosen scale (`electron/capture.js`).

## Tests

- `npm test`: unit tests (emoji handling, HTML escaping, the generated markup).
- `npm run test:visual`: the golden test. It opens the saved YouTube live-chat page (`yt_example_page/`,
  not included in the repository), screenshots real chat rows (plus owner, member, verified, timestamp,
  light-theme, classic-moderator and cropped-avatar variants made from them), renders the same comments
  with the app and compares the images pixel by pixel. All 100 cases are identical at 1×, 1.25×, 1.5×
  and 2×. It skips itself when the saved page isn't present.
- `node scripts/electron.js test/smoke/capture.js`: the capture pipeline (sizes at every scale, queueing,
  timeouts, crash recovery).
- `node scripts/electron.js test/smoke/app.js`: the whole app, run hidden: editing, saving, copying,
  restoring saved settings, and the security checks.

## Project layout

```
electron/     main process: windows, IPC, the app:// protocol, capture
src/editor/   the editor window
src/stage/    the page the comment is rendered (and captured) in
src/comment/  markup, emoji, badges and avatars
src/styles/   YouTube's chat CSS and the Roboto font faces
test/         unit tests, smoke tests and the visual golden test
```
