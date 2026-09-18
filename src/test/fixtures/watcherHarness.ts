import * as vscode from 'vscode';
import { writeFile } from 'node:fs/promises';
import { PACKAGE_JSON_WATCHER_DEBOUNCE_MS, registerPackageJsonWatcher } from '../../extension';
import { FilterManager, GroupItem, PackageItem, PackagesProvider, WorkspaceFolderItem } from '../../providers';

/**
 * Ceiling for the native file-watcher backend to attach to a freshly added workspace folder.
 * `createFileSystemWatcher()` returns synchronously but the backend attaches later, so a single
 * write issued before it is live produces no event at all — see `writeUntil`.
 */
export const NATIVE_WATCHER_ATTACH_TIMEOUT_MS = 30000;

/**
 * How long each `writeUntil` attempt waits before rewriting the file. Must stay above
 * `PACKAGE_JSON_WATCHER_DEBOUNCE_MS`: a retry faster than the debounce cancels the pending
 * reload on every pass, so writes are observed but the reload never runs.
 */
const WRITE_RETRY_INTERVAL_MS = PACKAGE_JSON_WATCHER_DEBOUNCE_MS * 2;
const POLL_INTERVAL_MS = 50;

/** Margin added on top of a debounce window before a count is read as settled. */
const SETTLE_MARGIN_MS = 200;

/**
 * How long to wait for a debounced reload to land — used both to observe the
 * reload and, after it, to prove that nothing further follows.
 */
export const DEBOUNCE_SETTLE_MS = PACKAGE_JSON_WATCHER_DEBOUNCE_MS + SETTLE_MARGIN_MS;

/** How long after `fn()` returns `withWriteSuppressed()` lifts suppression. */
const SUPPRESSION_LIFT_MS = 600;

/**
 * How long to wait before a suppressed write can be called unobserved: the lift
 * delay plus a full debounce window for any event it released.
 */
export const SUPPRESSION_SETTLE_MS = SUPPRESSION_LIFT_MS + DEBOUNCE_SETTLE_MS;

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const EXTENSION_ID = 'greentech-solutions.nestro';

/**
 * Suites that watch the filesystem must call this: the runner's file order is not
 * alphabetical, so a watcher suite can run before the activation suite, and an inactive
 * extension has not started its file-watching service — writes then go unobserved forever.
 */
export async function ensureExtensionActivated(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (extension === undefined) {
    throw new Error(`Extension ${EXTENSION_ID} is not registered in this Extension Host.`);
  }
  if (!extension.isActive) {
    await extension.activate();
  }
}

/**
 * Rewrites `path` until `condition` holds. Retrying the write is what makes
 * this reliable: whichever attempt lands first after the watcher backend
 * attaches is the one that produces an observable event.
 */
export async function writeUntil(
  path: string,
  buildContent: (attempt: number) => string,
  condition: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    await writeFile(path, buildContent(attempts), 'utf8');

    const windowEnd = Date.now() + WRITE_RETRY_INTERVAL_MS;
    while (!condition() && Date.now() < windowEnd) {
      await delay(POLL_INTERVAL_MS);
    }
    if (condition()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description} `
        + `(${attempts} rewrite(s) of ${path} produced no observed change).`,
      );
    }
  }
}

export interface StubExtensionContext {
  readonly subscriptions: { dispose(): unknown }[];
}

/** The registrators only ever touch `subscriptions`, so this is context enough. */
export function createStubContext(): StubExtensionContext {
  return { subscriptions: [] };
}

export function disposeStubContext(context: StubExtensionContext): void {
  while (context.subscriptions.length > 0) {
    context.subscriptions.pop()?.dispose();
  }
}

/**
 * Resolves the next time `onDidChangeTreeData` fires. The listener subscribes
 * synchronously, so a caller that starts this before triggering its mutation
 * cannot miss the event.
 */
export function onceTreeChanged(
  provider: Pick<PackagesProvider, 'onDidChangeTreeData'>,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`onDidChangeTreeData did not fire within ${timeoutMs}ms.`));
    }, timeoutMs);
    const disposable = provider.onDidChangeTreeData(() => {
      clearTimeout(timer);
      disposable.dispose();
      resolve();
    });
  });
}

/** Every `PackageItem` reachable from the tree, whatever its grouping shape. */
export function collectPackageItems(provider: PackagesProvider): PackageItem[] {
  const packages: PackageItem[] = [];
  const walk = (items: vscode.TreeItem[]): void => {
    for (const item of items) {
      if (item instanceof PackageItem) {
        packages.push(item);
      }
      else if (item instanceof GroupItem || item instanceof WorkspaceFolderItem) {
        walk(item.children);
      }
    }
  };
  walk(provider.getChildren());
  return packages;
}

export interface PackageJsonWatcherHarness {
  readonly provider: PackagesProvider;
  readonly controller: vscode.Disposable & { refresh(): void };
  loadCount(): number;
  dispose(): void;
}

/**
 * Registers the real `registerPackageJsonWatcher` against a real provider and
 * counts reloads. Counting calls — rather than only observing that the tree
 * changed — is what lets tests assert "exactly once" and "never".
 */
export function createPackageJsonWatcherHarness(): PackageJsonWatcherHarness {
  const provider = new PackagesProvider(new FilterManager('all'));
  const context = createStubContext();
  let count = 0;

  const spy: Pick<PackagesProvider, 'invalidateUpdateCache' | 'loadPackages' | 'suppressingWrites'> = {
    invalidateUpdateCache: () => provider.invalidateUpdateCache(),
    loadPackages: async () => {
      count += 1;
      await provider.loadPackages();
    },
    get suppressingWrites(): boolean {
      return provider.suppressingWrites;
    },
  };

  const controller = registerPackageJsonWatcher(context as unknown as vscode.ExtensionContext, spy);
  return {
    provider,
    controller,
    loadCount: () => count,
    dispose: () => {
      disposeStubContext(context);
      provider.dispose();
    },
  };
}

/**
 * Sets a `nestro.*` setting at workspace scope and returns a restore function. Both await the
 * matching `onDidChangeConfiguration`, since `config.update()` resolves once the write is
 * queued, not once delivered — otherwise a late event could leak into the next test.
 */
export async function setNestroConfigValue(key: string, value: unknown): Promise<() => Promise<void>> {
  const original = vscode.workspace.getConfiguration('nestro').inspect(key)?.workspaceValue;
  await applyNestroConfigValue(key, value);
  return () => applyNestroConfigValue(key, original);
}

async function applyNestroConfigValue(key: string, value: unknown): Promise<void> {
  const section = `nestro.${key}`;
  const delivered = onceConfigurationChanged(section);
  await vscode.workspace.getConfiguration('nestro').update(key, value, vscode.ConfigurationTarget.Workspace);
  await delivered;
}

/**
 * Resolves once VS Code reports a change affecting `section`. An unchanged
 * value produces no event, so this resolves on a short timeout rather than
 * failing — a no-op write is a legitimate outcome when restoring.
 */
function onceConfigurationChanged(section: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(section)) {
        finish();
      }
    });
  });
}