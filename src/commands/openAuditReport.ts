import * as vscode from 'vscode';
import { formatAuditReport } from '../utils';
import type { PackagesProvider } from '../providers';

/** Writes the latest project-scoped audit snapshot to the one reusable output channel. */
export function openAuditReportCommand(
  provider: Pick<PackagesProvider, 'getAuditReport'>,
  outputChannel: vscode.OutputChannel,
): void {
  const report = provider.getAuditReport();
  outputChannel.replace(formatAuditReport(report.projects, report.failures));
  outputChannel.show(true);
}