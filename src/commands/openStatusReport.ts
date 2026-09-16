import * as vscode from 'vscode';
import { formatStatusReport } from '../utils';
import type { PackagesProvider } from '../providers';

/** Writes the current read, update, and audit diagnostics to one reusable channel. */
export function openStatusReportCommand(
  provider: Pick<PackagesProvider, 'getStatusReport'>,
  outputChannel: vscode.OutputChannel,
): void {
  outputChannel.replace(formatStatusReport(provider.getStatusReport()));
  outputChannel.show(true);
}