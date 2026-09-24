// Extension Test Host driver: steps the Nestro sidebar through the four
// screenshot states and signals capture.mjs with marker files at each one.
//
// CommonJS: the Extension Test Host loads this module with `require`.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const MARKERS_DIR = process.env.NESTRO_CAPTURE_MARKERS_DIR;
const STATES = (process.env.NESTRO_CAPTURE_STATES || '').split(',').filter(Boolean);
const PARAMS = JSON.parse(process.env.NESTRO_CAPTURE_PARAMS || '{}');
const LOG_FILE = path.join(MARKERS_DIR, 'driver.log');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
}

function markReady(state) {
  fs.writeFileSync(path.join(MARKERS_DIR, `state-${state}.ready`), new Date().toISOString());
}

async function waitForDone(state, timeoutMs = 120000) {
  const markerPath = path.join(MARKERS_DIR, `state-${state}.done`);
  const start = Date.now();
  while (!fs.existsSync(markerPath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for capture.mjs to finish state "${state}"`);
    }
    await sleep(500);
  }
}

async function runCommand(id, ...args) {
  try {
    return await vscode.commands.executeCommand(id, ...args);
  }
  catch (error) {
    log(`command ${id} failed: ${error && error.message}`);
    return undefined;
  }
}

// Fire-and-forget: checkUpdates/runAudit resolve immediately and do their work in the
// background, so the driver advances on a fixed wait rather than the command's promise.
function fireCommand(id, ...args) {
  vscode.commands.executeCommand(id, ...args).then(
    () => log(`fired ${id}: resolved`),
    error => log(`fired ${id}: rejected ${error && error.message}`),
  );
}

exports.run = async function run() {
  log(`driver start; states=${STATES.join(',')}`);
  const extension = vscode.extensions.getExtension('greentech-solutions.nestro');
  log(`extension found: ${!!extension}, active: ${extension && extension.isActive}`);
  if (extension && !extension.isActive) {
    await extension.activate();
  }

  await runCommand('workbench.action.closeAuxiliaryBar');
  await runCommand('workbench.action.closePanel');
  await runCommand('workbench.action.closeAllEditors');
  await runCommand('workbench.view.extension.nestro');
  await sleep(1500);
  await runCommand('notifications.clearAll');
  await sleep(500);

  if (STATES.some(state => state !== 'audit')) {
    fireCommand('nestro.checkUpdates');
    await sleep(PARAMS.updateWaitMs ?? 30000);
    await runCommand('notifications.clearAll');
  }

  if (STATES.includes('overview')) {
    markReady('overview');
    await waitForDone('overview');
  }

  if (STATES.includes('filters')) {
    await runCommand('nestro.setFilter', PARAMS.filter ?? 'patch');
    await sleep(800);
    fireCommand('nestro.showFilterPicker');
    await sleep(1500);
    markReady('filters');
    await waitForDone('filters');
    await runCommand('workbench.action.closeQuickOpen');
    await sleep(500);
    await runCommand('nestro.setFilter', 'all');
    await sleep(800);
  }

  if (STATES.includes('pickVersion')) {
    // The tree's own PackageItem instances are the only argument nestro.pickVersion
    // accepts; the devext hook records them as they are constructed (see capture.mjs).
    // A missing or empty registry means the hook did not install, and a missing row means
    // the fixture/target drifted — both would otherwise fire pickVersion with `undefined`
    // and silently capture a frame with no QuickPick open, so both are hard failures.
    const registry = globalThis.__nestroShots;
    if (!registry || !Array.isArray(registry.items)) {
      throw new Error('globalThis.__nestroShots is missing; the instrumented bundle hook (capture.mjs buildInstrumentedExtension()) did not install.');
    }
    await runCommand('nestro.packagesView.focus');
    await sleep(500);
    if (typeof PARAMS.rowDown === 'number') {
      await runCommand('list.focusFirst');
      for (let i = 0; i < PARAMS.rowDown; i++) {
        await runCommand('list.focusDown');
        await sleep(60);
      }
    }
    await sleep(500);
    const targetName = PARAMS.pickName ?? 'express';
    const item = registry.items.filter(candidate => candidate.packageName === targetName).pop();
    log(`registry items: ${registry.items.length}; picked ${targetName}: ${!!item}`);
    if (!item) {
      throw new Error(`no PackageItem named "${targetName}" was recorded by the hook (registry has ${registry.items.length} item(s)); check the fixture dependencies and --states.`);
    }
    fireCommand('nestro.pickVersion', item);
    await sleep(PARAMS.pickWaitMs ?? 8000);
    markReady('pickVersion');
    await waitForDone('pickVersion');
    await runCommand('workbench.action.closeQuickOpen');
    await sleep(500);
    await runCommand('nestro.packagesView.focus');
    await runCommand('list.clear');
    await sleep(200);
    await runCommand('workbench.action.focusFirstEditorGroup');
    await sleep(500);
  }

  if (STATES.includes('audit')) {
    fireCommand('nestro.runAudit');
    await sleep(PARAMS.auditWaitMs ?? 30000);
    await runCommand('notifications.clearAll');
    await sleep(300);
    markReady('audit');
    await waitForDone('audit');
  }

  log('driver finished');
};
