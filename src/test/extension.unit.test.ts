import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

vi.mock('../PackagesProvider', () => ({
    PackagesProvider: vi.fn(function (this: Record<string, unknown>) {
        this.refresh = vi.fn().mockResolvedValue(undefined);
        this.dispose = vi.fn();
        this.onDidChangeTreeData = vi.fn();
        this.getTreeItem = vi.fn();
        this.getChildren = vi.fn(() => []);
    }),
    PackageItem: vi.fn(),
}));

function makeContext(): vscode.ExtensionContext {
    return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

describe('activate()', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('registers nestro.helloWorld command', () => {
        activate(makeContext());
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'nestro.helloWorld',
            expect.any(Function),
        );
    });

    it('registers nestro.refresh command', () => {
        activate(makeContext());
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'nestro.refresh',
            expect.any(Function),
        );
    });

    it('registers nestro.installUpdate command', () => {
        activate(makeContext());
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'nestro.installUpdate',
            expect.any(Function),
        );
    });

    it('registers tree data provider for nestro.packagesView', () => {
        activate(makeContext());
        expect(vscode.window.registerTreeDataProvider).toHaveBeenCalledWith(
            'nestro.packagesView',
            expect.any(Object),
        );
    });

    it('pushes all disposables to context.subscriptions', () => {
        const ctx = makeContext();
        activate(ctx);
        // helloWorld + registerTreeDataProvider + refresh + installUpdate + provider
        expect(ctx.subscriptions).toHaveLength(5);
    });

    it('helloWorld handler calls showInformationMessage', () => {
        activate(makeContext());
        const handler = vi.mocked(vscode.commands.registerCommand).mock.calls[0][1] as () => void;
        handler();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            'Hello World from Nestro again!',
        );
    });
});

describe('deactivate()', () => {
    it('runs without errors', () => {
        expect(() => deactivate()).not.toThrow();
    });
});
