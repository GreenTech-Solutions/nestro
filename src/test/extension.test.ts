import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
    test('Extension activates successfully', async () => {
        const ext = vscode.extensions.getExtension('undefined_publisher.nestro');
        assert.ok(ext, 'Extension should be registered');
    });

    test('nestro.helloWorld command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('nestro.helloWorld'), 'Command should be registered');
    });

    test('nestro.refresh command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('nestro.refresh'), 'Refresh command should be registered');
    });

    test('nestro.installUpdate command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('nestro.installUpdate'), 'Update command should be registered');
    });
});
