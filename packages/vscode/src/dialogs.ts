import * as vscode from 'vscode';

/**
 * The notifications, pickers and save dialogs the host opens. The extension-host tests cannot click them: they
 * replace these functions (`SeqcallTestApi.dialogs`) to answer, and to read what was said.
 */
export const dialogs = {
  info: (message: string, ...items: string[]): Thenable<string | undefined> => vscode.window.showInformationMessage(message, ...items),
  warning: (message: string, ...items: string[]): Thenable<string | undefined> => vscode.window.showWarningMessage(message, ...items),
  error: (message: string, ...items: string[]): Thenable<string | undefined> => vscode.window.showErrorMessage(message, ...items),
  save: (options: vscode.SaveDialogOptions): Thenable<vscode.Uri | undefined> => vscode.window.showSaveDialog(options),
  pick: <T extends vscode.QuickPickItem>(items: T[], options: vscode.QuickPickOptions): Thenable<T | undefined> => vscode.window.showQuickPick(items, options),
};
