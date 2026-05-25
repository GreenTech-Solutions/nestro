import { vi } from 'vitest';

export const commands = {
	registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};

export const window = {
	showInformationMessage: vi.fn<() => void>(),
};
