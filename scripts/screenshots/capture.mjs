#!/usr/bin/env node
// Captures the four Nestro README screenshots end to end: builds a throwaway
// workspace and an instrumented copy of the built extension, drives VS Code
// through the four states with @vscode/test-electron, captures each window
// with Quartz + screencapture, and crops/downscales the frames with sips.
//
// macOS only. See README.md for requirements (Screen Recording permission,
// a Python 3 with pyobjc-framework-Quartz) and for what each option does.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

const STATE_ORDER = ['overview', 'filters', 'pickVersion', 'audit'];
const OUTPUT_NAMES = { overview: 'overview', filters: 'filters', pickVersion: 'pick-version', audit: 'audit' };

// Layout constants measured on VS Code 1.138.0 / Dark Modern (images/SCREENSHOTS.md);
// scaled at runtime by the display's actual backing scale factor.
const ACTIVITY_BAR_WIDTH_PT = 48;
const SIDEBAR_CROP_WIDTH_PT = 348; // Activity Bar (48pt) + default sidebar (300pt)
const QUICKPICK_CROP_WIDTH_PT = 1030; // sidebar plus the QuickPick popup to its right
const TITLE_BAR_OFFSET_PT = 34; // below the native title bar, above the Activity Bar icons
const BOTTOM_SEARCH_MARGIN_PT = 40; // stays above the status bar when searching for content
const CONTENT_BOTTOM_MARGIN_PT = 20; // breathing room kept below the last detected content row

const QUIET_SETTINGS = {
  'workbench.colorTheme': 'Dark Modern',
  'workbench.startupEditor': 'none',
  'window.zoomLevel': 0,
  'workbench.tips.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': 'off',
  'security.workspace.trust.enabled': false,
  'workbench.editor.showTabs': 'none',
  'window.restoreWindows': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.commandCenter.enabled': false,
  'workbench.activityBar.location': 'default',
  'workbench.sideBar.location': 'left',
  'window.commandCenter': false,
};

// Reads the value that follows a flag, rejecting a missing value or one that is itself
// another flag, so a typo like a trailing `--out` prints a usage error instead of a TypeError.
function takeOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = { app: undefined, python: 'python3', states: [...STATE_ORDER], out: undefined, keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--app') {
      options.app = takeOptionValue(argv, i, arg);
      i++;
    }
    else if (arg === '--python') {
      options.python = takeOptionValue(argv, i, arg);
      i++;
    }
    else if (arg === '--states') {
      const value = takeOptionValue(argv, i, arg);
      i++;
      const requested = new Set(value.split(',').map(state => state.trim()).filter(Boolean));
      const unknown = [...requested].filter(state => !STATE_ORDER.includes(state));
      if (unknown.length > 0) {
        throw new Error(`unknown --states value(s): ${unknown.join(', ')} (expected a subset of ${STATE_ORDER.join(',')})`);
      }
      options.states = STATE_ORDER.filter(state => requested.has(state));
    }
    else if (arg === '--out') {
      options.out = takeOptionValue(argv, i, arg);
      i++;
    }
    else if (arg === '--keep-temp') {
      options.keepTemp = true;
    }
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
    else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.states.length === 0) {
    throw new Error('--states resolved to an empty list');
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/screenshots/capture.mjs [options]

Options:
  --app <path>       Path to "Visual Studio Code.app" (default: the newest
                      build under .vscode-test/stable/cache/).
  --python <path>    Python 3 interpreter with pyobjc Quartz (default: python3).
  --states <list>    Comma-separated subset of overview,filters,pickVersion,audit.
  --out <dir>        Output directory for the PNG frames (default: a temp
                      directory; pass --out images to overwrite the shipped
                      screenshots directly).
  --keep-temp        Keep the temporary workspace/user-data-dir for inspection.
`);
}

function findNewestVSCodeApp() {
  const cacheDir = path.join(REPO_ROOT, '.vscode-test', 'stable', 'cache');
  if (!fs.existsSync(cacheDir)) {
    return undefined;
  }
  const candidates = fs.readdirSync(cacheDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(cacheDir, entry.name, 'Visual Studio Code.app'))
    .filter(appPath => fs.existsSync(appPath))
    .map(appPath => ({ appPath, mtime: fs.statSync(appPath).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.appPath;
}

function resolveVSCodeExecutable(appOption) {
  const appPath = appOption ?? findNewestVSCodeApp();
  if (!appPath || !fs.existsSync(appPath)) {
    throw new Error(
      'No VS Code build found. Pass --app "<path>/Visual Studio Code.app", or run '
      + '`pnpm run test:stable` once to populate .vscode-test/stable/cache/.',
    );
  }
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Code');
  if (!fs.existsSync(executable)) {
    throw new Error(`"${appPath}" does not look like a VS Code.app bundle (missing Contents/MacOS/Code)`);
  }
  return executable;
}

function checkPython(pythonPath) {
  const result = spawnSync(pythonPath, ['-c', 'import Quartz'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `"${pythonPath}" cannot import Quartz (pyobjc-framework-Quartz). Create a venv outside `
      + 'the repository and pass --python, e.g.:\n'
      + '  python3 -m venv ~/.nestro-shots-venv && ~/.nestro-shots-venv/bin/pip install pyobjc-framework-Quartz\n'
      + '  node scripts/screenshots/capture.mjs --python ~/.nestro-shots-venv/bin/python\n'
      + `stderr: ${result.stderr?.trim() ?? ''}`,
    );
  }
}

function buildFixture(fixtureDir) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.cpSync(path.join(SCRIPT_DIR, 'fixture'), fixtureDir, { recursive: true });
  const npmSteps = [['install', '--package-lock-only', '--ignore-scripts'], ['install', '--ignore-scripts']];
  for (const args of npmSteps) {
    const result = spawnSync('npm', args, { cwd: fixtureDir, stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(
        `"npm ${args.join(' ')}" failed in the fixture workspace (needs network access to the npm registry).`,
      );
    }
  }
}

function buildInstrumentedExtension(extensionDir) {
  fs.mkdirSync(extensionDir, { recursive: true });
  const builtBundlePath = path.join(REPO_ROOT, 'out', 'extension.cjs');
  if (!fs.existsSync(builtBundlePath)) {
    throw new Error('out/extension.cjs is missing. Build the extension first: pnpm run build');
  }
  for (const name of ['package.json', 'package.nls.json', 'resources', 'out']) {
    const source = path.join(REPO_ROOT, name);
    if (fs.existsSync(source)) {
      fs.cpSync(source, path.join(extensionDir, name), { recursive: true });
    }
  }
  const bundlePath = path.join(extensionDir, 'out', 'extension.cjs');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  const hookTarget = 'var PackageItem = class extends';
  if (!bundle.includes(hookTarget)) {
    throw new Error(
      'Could not find the PackageItem class declaration in the built bundle; the tsdown output '
      + 'shape may have changed. See README.md ("Why the instrumented bundle").',
    );
  }
  // nestro.pickVersion only accepts the tree's own PackageItem instances
  // (resolvePackageItem() rejects anything else); this records them as the
  // instrumented copy of the extension constructs them, so the driver can
  // pass a live one back into the command. The repository's own out/ is
  // never touched — only this temporary copy is patched.
  const hook = '\nglobalThis.__nestroShots = { items: [] };\n'
    + '{ const Base = PackageItem; PackageItem = class extends Base { '
    + 'constructor(...args) { super(...args); globalThis.__nestroShots.items.push(this); } }; }\n';
  fs.writeFileSync(bundlePath, bundle + hook);
}

function buildUserDataDir() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-ud-'));
  const userDir = path.join(userDataDir, 'User');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify(QUIET_SETTINGS, null, 2));
  return userDataDir;
}

// --- Minimal PNG decoder (8-bit RGB/RGBA only) for locating crop edges. ---

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG file (bad signature)');
  }
  let pos = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idatChunks = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    }
    else if (type === 'IDAT') {
      idatChunks.push(data);
    }
    pos += 8 + length + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`unsupported PNG format (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`unsupported PNG format (decompressed length ${raw.length}, expected ${height * (stride + 1)})`);
  }
  const pixels = Buffer.alloc(height * stride);
  let rawPos = 0;
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos];
    rawPos += 1;
    const row = Buffer.from(raw.subarray(rawPos, rawPos + stride));
    rawPos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      if (filter === 1) {
        row[x] = (row[x] + a) & 0xff;
      }
      else if (filter === 2) {
        row[x] = (row[x] + b) & 0xff;
      }
      else if (filter === 3) {
        row[x] = (row[x] + ((a + b) >> 1)) & 0xff;
      }
      else if (filter === 4) {
        row[x] = (row[x] + paeth(a, b, c)) & 0xff;
      }
      else if (filter !== 0) {
        throw new Error(`unsupported PNG scanline filter ${filter}`);
      }
    }
    row.copy(pixels, y * stride);
    prevRow = row;
  }
  return { width, height, bpp, stride, pixels };
}

function pixelAt(image, x, y) {
  const offset = y * image.stride + x * image.bpp;
  return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]];
}

function colorsClose(a, b, tolerance = 12) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance && Math.abs(a[2] - b[2]) <= tolerance;
}

function sampleRow(image, y, left, width, step) {
  const samples = [];
  for (let x = left; x < left + width; x += step) {
    samples.push(pixelAt(image, x, y));
  }
  return samples;
}

function rowDiffersFromReference(image, y, left, width, step, reference) {
  let index = 0;
  let diffCount = 0;
  for (let x = left; x < left + width; x += step) {
    if (!colorsClose(pixelAt(image, x, y), reference[index])) {
      diffCount++;
    }
    index++;
  }
  return diffCount > reference.length * 0.02;
}

// Trims blank sidebar/editor space below the last visible row: compares each
// candidate row against a reference row sampled near the bottom of the
// search window (assumed empty), stopping at the first row that differs.
function detectContentBottom(image, top, left, width, bottomBound, marginPx, fallback) {
  const step = Math.max(1, Math.floor(width / 64));
  const referenceY = Math.max(top, Math.min(image.height - 1, bottomBound - 2));
  const reference = sampleRow(image, referenceY, left, width, step);
  for (let y = bottomBound; y > top; y--) {
    if (rowDiffersFromReference(image, y, left, width, step, reference)) {
      return Math.min(bottomBound, y + marginPx);
    }
  }
  return fallback;
}

// The top offset and the Activity-Bar-plus-sidebar width are fixed (measured on VS Code
// 1.138.0 / Dark Modern, images/SCREENSHOTS.md): away from the traffic-light buttons the
// title bar's background is visually indistinguishable from the sidebar's, so scanning for
// that edge is unreliable; the sidebar width is a stable VS Code default, not content-driven.
// Only the bottom edge is content-dependent and worth detecting dynamically.
function computeCrop(rawPngPath, kind, scale) {
  const image = decodePng(fs.readFileSync(rawPngPath));
  const top = Math.min(image.height - 1, Math.round(TITLE_BAR_OFFSET_PT * scale));
  const crossWidthPt = kind === 'sidebar' ? SIDEBAR_CROP_WIDTH_PT : QUICKPICK_CROP_WIDTH_PT;
  const width = Math.min(image.width, Math.round(crossWidthPt * scale));
  // The Activity Bar carries its own fixed icons (Accounts, Settings) near the window
  // bottom regardless of sidebar content, so it is excluded from the bottom-edge scan —
  // included only in the crop itself.
  const scanLeft = Math.min(width, Math.round(ACTIVITY_BAR_WIDTH_PT * scale));
  const scanWidth = Math.max(1, width - scanLeft);
  const bottomBound = Math.min(image.height - 1, Math.round(image.height - BOTTOM_SEARCH_MARGIN_PT * scale));
  const marginPx = Math.round(CONTENT_BOTTOM_MARGIN_PT * scale);
  const bottom = detectContentBottom(image, top, scanLeft, scanWidth, bottomBound, marginPx, bottomBound);
  const height = Math.max(1, bottom - top);
  return { top, left: 0, width, height };
}

function runSips(args) {
  const result = spawnSync('sips', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`sips ${args.join(' ')} failed: ${result.stderr?.trim() ?? result.stdout?.trim()}`);
  }
}

function pngSize(pngPath) {
  const result = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', pngPath], { encoding: 'utf8' });
  const width = /pixelWidth: (\d+)/.exec(result.stdout)?.[1];
  const height = /pixelHeight: (\d+)/.exec(result.stdout)?.[1];
  return { width: Number(width), height: Number(height) };
}

function captureState(state, pythonPath, userDataDir, tempRoot, outDir) {
  const rawPath = path.join(tempRoot, `raw-${state}.png`);
  const capturePy = path.join(SCRIPT_DIR, 'capture.py');
  const result = spawnSync(pythonPath, [capturePy, userDataDir, rawPath], { encoding: 'utf8' });
  const lastLine = result.stdout.trim().split('\n').pop() ?? '';
  let parsed;
  try {
    parsed = JSON.parse(lastLine);
  }
  catch {
    throw new Error(`capture.py produced no parseable output for "${state}": ${result.stdout}\n${result.stderr}`);
  }
  if (!parsed.ok) {
    throw new Error(`capture.py failed for "${state}": ${parsed.error}`);
  }

  const rawSize = pngSize(rawPath);
  const scale = rawSize.width / parsed.bounds.Width;
  const kind = state === 'overview' || state === 'audit' ? 'sidebar' : 'quickpick';
  const crop = computeCrop(rawPath, kind, scale);

  const croppedPath = path.join(tempRoot, `cropped-${state}.png`);
  runSips(['--cropOffset', String(crop.top), String(crop.left), '-c', String(crop.height), String(crop.width), rawPath, '--out', croppedPath]);

  const finalWidth = Math.max(1, Math.round(crop.width / scale));
  const outputPath = path.join(outDir, `${OUTPUT_NAMES[state]}.png`);
  runSips(['--resampleWidth', String(finalWidth), croppedPath, '--out', outputPath]);

  const finalSize = pngSize(outputPath);
  console.log(`  ${OUTPUT_NAMES[state]}.png — ${finalSize.width}x${finalSize.height}`);
  return outputPath;
}

// `signal` is checked on every poll so a marker wait bails out as soon as the caller knows VS
// Code has already exited, rather than idling for up to its own timeout (mirrors the
// prototype's `kill -0 $RUNNER` liveness check in its own ready-marker wait loop).
async function waitForMarker(markerPath, timeoutMs, signal) {
  const start = Date.now();
  while (!fs.existsSync(markerPath)) {
    if (signal.aborted) {
      throw new Error(`aborted waiting for ${markerPath} (VS Code process already exited)`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${markerPath}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function orchestrateCaptures(states, markersDir, pythonPath, userDataDir, tempRoot, outDir, signal) {
  for (const state of states) {
    console.log(`Waiting for state "${state}"...`);
    await waitForMarker(path.join(markersDir, `state-${state}.ready`), 300000, signal);
    await new Promise(resolve => setTimeout(resolve, 1000));
    captureState(state, pythonPath, userDataDir, tempRoot, outDir);
    fs.writeFileSync(path.join(markersDir, `state-${state}.done`), new Date().toISOString());
  }
}

// Best-effort: on an orchestration failure this stops the Extension Host immediately instead
// of leaving driver.cjs to run out its own wait timeout. A no-op if VS Code already exited.
function terminateVSCode(userDataDir) {
  spawnSync('pkill', ['-f', `user-data-dir=${userDataDir}`]);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (process.platform !== 'darwin') {
    console.error(
      `Nestro screenshot capture only runs on macOS (uses Quartz window lookup and screencapture); `
      + `detected platform "${process.platform}". See README.md for the manual fallback.`,
    );
    process.exitCode = 1;
    return;
  }

  const vscodeExecutable = resolveVSCodeExecutable(options.app);
  checkPython(options.python);
  const { runTests } = await import('@vscode/test-electron');

  const outDir = options.out ? path.resolve(process.cwd(), options.out) : fs.mkdtempSync(path.join(os.tmpdir(), 'nestro-frames-'));
  fs.mkdirSync(outDir, { recursive: true });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nestro-shots-'));
  const fixtureDir = path.join(tempRoot, 'fixture');
  const extensionDir = path.join(tempRoot, 'ext');
  const extensionsInstallDir = path.join(tempRoot, 'extdir');
  const markersDir = path.join(tempRoot, 'markers');
  fs.mkdirSync(extensionsInstallDir, { recursive: true });
  fs.mkdirSync(markersDir, { recursive: true });
  const userDataDir = buildUserDataDir();

  try {
    console.log('Building the fixture workspace (needs network access)...');
    buildFixture(fixtureDir);
    console.log('Building the instrumented extension copy...');
    buildInstrumentedExtension(extensionDir);

    delete process.env.ELECTRON_RUN_AS_NODE;
    const runTestsPromise = runTests({
      vscodeExecutablePath: vscodeExecutable,
      extensionDevelopmentPath: extensionDir,
      extensionTestsPath: path.join(SCRIPT_DIR, 'driver.cjs'),
      launchArgs: [
        fixtureDir,
        '--disable-extensions',
        '--disable-workspace-trust',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsInstallDir}`,
      ],
      extensionTestsEnv: {
        NESTRO_CAPTURE_STATES: options.states.join(','),
        NESTRO_CAPTURE_MARKERS_DIR: markersDir,
        NESTRO_CAPTURE_PARAMS: JSON.stringify({
          updateWaitMs: 30000,
          auditWaitMs: 30000,
          filter: 'patch',
          pickWaitMs: 8000,
          rowDown: 4,
          pickName: 'express',
        }),
      },
    });
    // Aborts any in-progress marker wait as soon as VS Code exits, successfully or not, so a
    // crashed or already-finished process is never waited on for the rest of its timeout.
    const controller = new AbortController();
    runTestsPromise.then(() => controller.abort(), () => controller.abort());

    console.log('Driving VS Code through the requested states...');
    await Promise.all([
      runTestsPromise,
      orchestrateCaptures(options.states, markersDir, options.python, userDataDir, tempRoot, outDir, controller.signal),
    ]);

    console.log(`\nFrames written to ${outDir}`);
    if (!options.keepTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    else {
      console.log(`Kept temporary workspace at ${tempRoot} and user-data-dir at ${userDataDir}`);
    }
  }
  catch (error) {
    // Stop the Extension Host immediately rather than leaving it running for minutes, and
    // always keep the temporary workspace (including driver.log) so the failure can be
    // diagnosed — regardless of --keep-temp, which only governs the success path.
    terminateVSCode(userDataDir);
    console.error(`Capture failed; kept the temporary workspace for inspection: ${tempRoot}`);
    console.error(`Driver log: ${path.join(markersDir, 'driver.log')}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
