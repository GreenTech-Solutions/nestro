import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  let extension: vscode.Extension<unknown>;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension('greentech-solutions.nestro');
    assert.ok(ext, 'Extension should be registered');
    extension = ext;
    await extension.activate();
  });

  test('Extension activates successfully', () => {
    assert.strictEqual(extension.isActive, true);
  });

  test('nestro.refresh command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.refresh'), 'Refresh command should be registered');
  });

  test('nestro.installUpdate command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.installUpdate'), 'Update command should be registered');
  });

  test('nestro.pickVersion command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.pickVersion'), 'Pick version command should be registered');
  });

  test('nestro.runInstall command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.runInstall'), 'Run install command should be registered');
  });

  test('nestro.updateAllVisible command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.updateAllVisible'), 'Update all command should be registered');
  });

  test('nestro.runAudit command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.runAudit'), 'Run audit command should be registered');
  });

  test('nestro.removePackage command is registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('nestro.removePackage'), 'Remove package command should be registered');
  });
});