import { vi } from 'vitest';

export const commands = {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
};

export const window = {
    showInformationMessage: vi.fn<() => void>(),
    showQuickPick: vi.fn(),
    registerTreeDataProvider: vi.fn(() => ({ dispose: vi.fn() })),
    createTerminal: vi.fn(() => ({ sendText: vi.fn(), show: vi.fn() })),
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
