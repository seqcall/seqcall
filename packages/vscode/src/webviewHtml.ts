import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [webviewRoot(extensionUri)],
  };
}

/**
 * HTML shell for a webview bundle (`sequence.js` / `class.js`) with a strict CSP:
 * scripts only via nonce, styles/fonts/images only from the extension's webview folder.
 * (Inline styles are allowed because the SVG renderer sets style attributes.)
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const root = webviewRoot(extensionUri);
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(root, script));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css'));
  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<title>${title}</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
