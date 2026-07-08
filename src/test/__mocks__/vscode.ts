import { vi } from 'vitest';

export const outputChannel = {
  appendLine: vi.fn(),
  dispose: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(),
};

export const env = {
  openExternal: vi.fn().mockResolvedValue(true),
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
};

export const window = {
  showInformationMessage: vi.fn<() => void>(),
  showErrorMessage: vi.fn<() => void>(),
  showWarningMessage: vi.fn(),
  showQuickPick: vi.fn(),
  createInputBox: vi.fn(() => ({
    title: undefined,
    prompt: undefined,
    placeholder: undefined,
    value: '',
    buttons: [],
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    onDidAccept: vi.fn(() => ({ dispose: vi.fn() })),
    onDidHide: vi.fn(() => ({ dispose: vi.fn() })),
    onDidTriggerButton: vi.fn(() => ({ dispose: vi.fn() })),
  })),
  createQuickPick: vi.fn(() => ({
    title: undefined,
    placeholder: undefined,
    busy: false,
    items: [],
    selectedItems: [],
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    onDidAccept: vi.fn(() => ({ dispose: vi.fn() })),
  })),
  registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createTreeView: vi.fn(() => ({ dispose: vi.fn(), badge: undefined, message: undefined })),
  createOutputChannel: vi.fn(() => outputChannel),
};

export const tasks = {
  executeTask: vi.fn().mockResolvedValue({ id: 'task-execution' }),
  onDidEndTaskProcess: vi.fn(() => ({ dispose: vi.fn() })),
  onDidEndTask: vi.fn(() => ({ dispose: vi.fn() })),
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  createFileSystemWatcher: vi.fn(() => ({
    dispose: vi.fn(),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
    onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDelete: vi.fn(() => ({ dispose: vi.fn() })),
  })),
  workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  getWorkspaceFolder: vi.fn((uri: { fsPath: string }) => {
    const folder = workspace.workspaceFolders.find(candidate => uri.fsPath.startsWith(candidate.uri.fsPath));
    return folder;
  }),
  findFiles: vi.fn().mockResolvedValue([]),
  fs: {
    readFile: vi.fn().mockResolvedValue(Buffer.from('{}')),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
};

export class RelativePattern {
  constructor(
    public readonly base: unknown,
    public readonly pattern: string,
  ) {}
}

export const Uri = {
  joinPath: vi.fn((base: { fsPath: string }, path: string) => ({
    fsPath: `${base.fsPath}/${path}`,
    toString: () => `${base.fsPath}/${path}`,
  })),
  file: vi.fn((value: string) => ({
    fsPath: value,
    path: value,
    toString: () => value,
  })),
  parse: vi.fn((value: string) => ({
    toString: () => value,
  })),
};

export class EventEmitter<T = void> {
  private readonly listeners: ((e: T) => unknown)[] = [];

  event = vi.fn((listener: (e: T) => unknown) => {
    this.listeners.push(listener);
    return { dispose: vi.fn() };
  }) as unknown as Event & ((listener: (e: T) => unknown) => { dispose: () => void });

  fire = vi.fn((event: T) => {
    for (const listener of this.listeners) {
      listener(event);
    }
  });

  dispose = vi.fn();
}

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown,
  ) {}
}

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export const ShellQuoting = {
  Escape: 1,
  Strong: 2,
  Weak: 3,
} as const;

export class ShellExecution {
  public readonly commandLine: string;
  public readonly command?: string | { value: string; quoting: number };
  public readonly args?: (string | { value: string; quoting: number })[];
  public readonly options?: unknown;

  constructor(
    commandOrLine: string | { value: string; quoting: number },
    argsOrOptions?: (string | { value: string; quoting: number })[] | unknown,
    maybeOptions?: unknown,
  ) {
    if (Array.isArray(argsOrOptions)) {
      this.command = commandOrLine;
      this.args = argsOrOptions;
      this.options = maybeOptions;
      this.commandLine = [commandOrLine, ...argsOrOptions]
        .map(part => typeof part === 'string' ? part : part.value)
        .join(' ');
      return;
    }

    this.commandLine = String(commandOrLine);
    this.options = argsOrOptions;
  }
}

export class Task {
  public presentationOptions?: unknown;

  constructor(
    public readonly definition: unknown,
    public readonly scope: unknown,
    public readonly name: string,
    public readonly source: string,
    public readonly execution: ShellExecution,
  ) {}
}

export const TaskScope = {
  Workspace: 1,
} as const;

export const TaskRevealKind = {
  Always: 1,
} as const;

export const TaskPanelKind = {
  New: 2,
} as const;

export class TreeItem {
  public description?: string;
  public tooltip?: string;
  public contextValue?: string;
  public iconPath?: unknown;
  public command?: unknown;

  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;
