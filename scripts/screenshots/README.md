# Screenshot capture tooling

Reproduces the four README screenshots (`images/overview.png`, `images/filters.png`,
`images/pick-version.png`, `images/audit.png`) from a real, running instance of the
extension, instead of by hand. See `images/SCREENSHOTS.md` for what each frame shows
and the manual fallback if this tool cannot run on your machine.

## What it does

`capture.mjs` builds a throwaway workspace, starts a VS Code Extension Test Host through
`@vscode/test-electron`, drives the Nestro sidebar through four states (overview, filter
picker, pick-version picker, audit), captures each window, and crops/downscales the result
into the four PNG frames.

## Requirements

- **macOS.** The capture step uses Quartz window lookup and `screencapture -l <window id>`,
  which have no equivalent used here on other platforms; the tool exits immediately with a
  message if `process.platform !== 'darwin'`.
- **Screen Recording permission** for whichever process launches this script (System
  Settings → Privacy & Security → Screen Recording). `screencapture` silently fails without
  it. If you run the script from a terminal that is not yet authorized, grant the permission
  to that terminal app and relaunch it.
- **Python 3 with `pyobjc-framework-Quartz`**, used only to look up the window by owning
  process ID and read its bounds. Keep the interpreter outside this repository (or otherwise
  gitignored) and point `--python` at it:

  ```sh
  python3 -m venv ~/.nestro-shots-venv
  ~/.nestro-shots-venv/bin/pip install pyobjc-framework-Quartz
  node scripts/screenshots/capture.mjs --python ~/.nestro-shots-venv/bin/python
  ```

- **A built extension.** `capture.mjs` copies `out/`, `package.json`, `package.nls.json`
  and `resources/` from the repository root into its instrumented copy; run `pnpm run build`
  first. The tool refuses to run if `out/extension.cjs` is missing.
- **A cached VS Code build**, used only to locate the executable — `--app` overrides it, or
  run `pnpm run test:stable` once to populate `.vscode-test/stable/cache/`.
- **Network access**, to `npm install` the fixture's dependencies (see below).

## Running it

```sh
node scripts/screenshots/capture.mjs
```

Frames land in a fresh temporary directory by default; the tool prints its path when it
finishes. Pass `--out images` to overwrite the shipped screenshots directly:

```sh
node scripts/screenshots/capture.mjs --out images
```

A `screenshots` script in `package.json` runs the same command (`pnpm run screenshots`);
it needs nothing pnpm-specific.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--app <path>` | newest `.vscode-test/stable/cache/*/Visual Studio Code.app` | The VS Code build to launch. |
| `--python <path>` | `python3` | Interpreter with `pyobjc-framework-Quartz` importable. |
| `--states <list>` | `overview,filters,pickVersion,audit` | Comma-separated subset to capture. |
| `--out <dir>` | a temporary directory | Where the four PNGs are written. |
| `--keep-temp` | off | Keep the temporary workspace and user-data-dir for inspection. |

## The fixture workspace

`fixture/package.json` (plus a one-line `fixture/src/index.js`) is the same `demo-app`
described in `images/SCREENSHOTS.md`: public npm packages only, no private registries or
credentials. For each run, the tool copies it into a fresh directory under `os.tmpdir()`
and runs, in order:

```sh
npm install --package-lock-only --ignore-scripts
npm install --ignore-scripts
```

Both commands need network access to the npm registry; the "latest" versions shown in the
captured frames are whatever the registry returns on the day you run this, and will drift
over time.

## Why the instrumented bundle

`nestro.pickVersion` only accepts the tree's own `PackageItem` instances —
`resolvePackageItem()` rejects any duck-typed or reconstructed argument as not current — so
the driver needs a live reference to a row the provider actually built. `capture.mjs` copies
the built `out/extension.cjs` into its temporary extension directory and appends a small hook
that intercepts every `PackageItem` construction and records it on `globalThis.__nestroShots`,
so `driver.cjs` can look one up by package name and pass it straight back into the command.
This only ever touches the temporary copy — the repository's own `out/` is never modified.

## The driver

`driver.cjs` is the `extensionTestsPath` module the Extension Test Host loads with `require`
(hence CommonJS, unlike the ESM `capture.mjs`). It steps through the requested states, writing
a `state-<name>.ready` marker file when a frame is ready to capture and waiting for
`capture.mjs` to write back `state-<name>.done` before moving on — the same ready/done marker
handshake used to build the original, untracked version of this pipeline. Parameters (update
and audit wait times, active filter, pick-version target and row) travel through the
`NESTRO_CAPTURE_PARAMS` environment variable as JSON.

## Cropping and downscaling

Frames are captured at the display's native (often 2x/Retina) resolution and cropped with
`sips --cropOffset <y> <x> -c <height> <width>`. The Activity-Bar-plus-sidebar frames
(`overview`, `audit`) crop a fixed-width column starting at `x=0`; the QuickPick frames
(`filters`, `pick-version`) crop a wider fixed-width column that also includes the sidebar
behind the popup. The top edge and both frame widths are fixed constants
(`TITLE_BAR_OFFSET_PT`, `SIDEBAR_CROP_WIDTH_PT`, `QUICKPICK_CROP_WIDTH_PT` in `capture.mjs`)
measured on VS Code 1.138.0 with the Dark Modern theme — away from the traffic-light buttons,
the title bar's background is visually indistinguishable from the sidebar's, so scanning for
that edge pixel by pixel is unreliable, and the sidebar/QuickPick widths are stable VS Code
defaults rather than content-driven. Only the bottom edge is detected per frame
(`detectContentBottom()`), by comparing candidate rows against a background sample from the
same frame — the number of visible rows changes between states and over time as the fixture's
dependencies gain or lose updates, so this is the one edge that is worth finding dynamically.
If a frame's top or width ever needs adjusting (a different VS Code version, theme, or sidebar
default), change those constants directly; `CONTENT_BOTTOM_MARGIN_PT` controls how much blank
space is kept below the detected content. The crop is then downscaled to 1x with
`sips --resampleWidth`. Expect the resulting sizes to track `images/SCREENSHOTS.md`'s table
closely but not always exactly, since the pixel content (and therefore the detected bottom
edge) depends on live registry data.

## On other operating systems

`capture.mjs` checks `process.platform` before doing anything else and exits with a message
pointing at the manual steps in `images/SCREENSHOTS.md`. Nothing else in this directory is
imported unless that check passes.
