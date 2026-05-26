import { vi } from 'vitest';

export const outputChannel = {
    appendLine: vi.fn(),
    dispose: vi.fn(),
};

export const commands = {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
};

export const window = {
    showInformationMessage: vi.fn<() => void>(),
    showErrorMessage: vi.fn<() => void>(),
    showQuickPick: vi.fn(),
    registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
    createOutputChannel: vi.fn(() => outputChannel),
};

export const tasks = {
    executeTask: vi.fn().mockResolvedValue({ id: 'task-execution' }),
    onDidEndTaskProcess: vi.fn(() => ({ dispose: vi.fn() })),
};

export const workspace = {
    getConfiguration: vi.fn(() => ({
        get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    })),
    findFiles: vi.fn().mockResolvedValue([]),
    fs: {
        readFile: vi.fn().mockResolvedValue(Buffer.from('{}')),
    },
};

export class EventEmitter<T = void> {
    event = vi.fn() as unknown as Event & ((listener: (e: T) => unknown) => { dispose: () => void });
    fire = vi.fn();
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

export class ShellExecution {
    constructor(public readonly commandLine: string) {}
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
