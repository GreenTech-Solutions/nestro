import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

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

	it('pushes disposable to context.subscriptions', () => {
		const ctx = makeContext();
		activate(ctx);
		expect(ctx.subscriptions).toHaveLength(1);
	});

	it('command handler calls showInformationMessage with correct text', () => {
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
