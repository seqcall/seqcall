/**
 * Standalone host: serves the webview bundles in a plain browser and answers view
 * intents with a real DiagramSession. A root containing a .sln/.slnx is analysed with the C#
 * sidecar (SEQCALL_CSHARP_SIDECAR or the packages/csharp Release build), one with a composer.json
 * (and no tsconfig) with the PHP adapter (FR-18), anything else as JS/TS. Usage:
 *   node dist/server.cjs <projectRoot> [port]
 *   open http://localhost:<port>/sequence?file=src/main.ts&line=62[&actions=expandAll,tidy]
 *   or   http://localhost:<port>/sequence?entry=POST%20/api/orders (an entry point by its label, as ⌂ opens it: FR-8.7 / FR-18.14 steps)
 * `actions` (comma separated) are intents replayed after opening, for screenshots:
 *   expandAll (one level) | expandEverything[:<messageId>] | smart[:<messageId>] (FR-3.12 Overview) | foldErrors[:off] (↯) | changes[:<messageId>] (review changes) | focus:<messageId> | collapseAll | expand:<messageId> | collapse:<messageId> | fold:<fragmentId> | impl:<messageId>=<classKey> | hide:<methodName> | zoom[:off] (FR-28 layer zoom) | open:<lifeline key, e.g. layer:Application> (FR-28.7)
 *   | uses (FR-12.12: type uses on in the class diagram)
 */
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { addFindingIgnore, addLayerHintIgnore, configFileOf, createAdapter, entryPointTree, createClassifier, DiagramSession, formatState, parseState, stateFileName, layerScopes, relPathOfKey, removeIgnore, setLayerRule, unreachableScan, viewText, classViewText, askText, type LanguageAdapter, type ProjectLanguage } from '@seqcall/core';
import type { HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';

/** FR-19.10 / FR-7.11 / FR-19.22 Ignore and Stop ignoring: writes to .seqcall.json from either view. */
const CONFIG_IGNORES = new Set(['ignoreFinding', 'ignoreLayerHint', 'unignoreFinding', 'unignoreLayerHint']);

const projectRoot = resolve(process.argv[2] ?? '.').replace(/\\/g, '/');
const port = Number(process.argv[3] ?? 4711);
const webviewDist = resolve(__dirname, '../../webview/dist');

const entries = readdirSync(projectRoot);
const language: ProjectLanguage = entries.some((n) => /\.slnx?$/i.test(n))
  ? 'csharp'
  : entries.includes('composer.json') && !entries.some((n) => /^(tsconfig|jsconfig)\.json$/.test(n))
    ? 'php'
    : 'typescript';
const make = (): LanguageAdapter => createAdapter(language, projectRoot, { csharp: { log: (line) => console.error(`[C#] ${line}`) } });
const adapter = make();
const session = new DiagramSession({ adapter, classifier: createClassifier(projectRoot), createBaseAdapter: make });

async function replay(action: string): Promise<void> {
  const [verb, arg = ''] = action.split(/:(.*)/s);
  if (verb === 'expandAll') await session.expandAll();
  else if (verb === 'smart') await session.smartExpand(arg || undefined);
  else if (verb === 'foldErrors') await session.setOption('foldErrors', arg !== 'off');
  else if (verb === 'changes') await session.smartExpand(arg || undefined, false, 'changes');
  else if (verb === 'expandEverything') await session.expandEverything(arg || undefined);
  else if (verb === 'focus') await session.focus(arg);
  else if (verb === 'collapseAll') await session.collapseAll();
  else if (verb === 'expand') await session.expand(arg);
  else if (verb === 'collapse') await session.collapse(arg);
  else if (verb === 'fold') await session.collapseFragment(arg);
  else if (verb === 'follow') {
    // FR-1.22 follow:<fragmentId>=<case>
    const [id, c] = arg.split(/=(?=\d+$)/);
    await session.followCase(id, Number(c));
  } else if (verb === 'showErrorPath') await session.showErrorPath(arg);
  else if (verb === 'hide') await session.hide({ kind: 'methodName', methodName: arg });
  else if (verb === 'uses') await session.setOption('showTypeUses', arg !== 'off');
  else if (verb === 'zoom') await session.setOption('layerZoom', arg !== 'off'); // FR-28
  else if (verb === 'helpers') await session.setOption('mergeHelpers', arg !== 'off'); // FR-5.13
  else if (verb === 'open') await session.setLayerOpen(arg, true); // FR-28.7 open:layer:Application
  else if (verb === 'foldLayer') await session.setLayerOpen(arg, false); // FR-28.11 foldLayer:layer:Ports (object view: folds that layer)
  else if (verb === 'foldLayers') await session.foldAllLayers(); // FR-28.9
  else if (verb === 'impl') {
    const [messageId, classKey] = arg.split('=');
    await session.selectImplementation(messageId, classKey);
  }
}

function render(): HostToSequenceView {
  const diagram = session.current();
  return diagram ? { type: 'render', diagram } : { type: 'empty', reason: 'Open a flow from ⌂ Entry points, or give file= and line= inside a method body.' };
}

async function handle(msg: SequenceViewToHost): Promise<HostToSequenceView[]> {
  const s = session;
  switch (msg.type) {
    case 'ready': return [render()];
    case 'navigate': console.log('navigate', msg.range.file, msg.range.start.line + 1); return [];
    case 'requestCallers': return [{ type: 'callers', messageId: msg.messageId, callers: await s.getCallers(msg.messageId) }];
    case 'expand': await s.expand(msg.messageId); break;
    case 'collapse': await s.collapse(msg.messageId); break;
    case 'expandAll': await (msg.oneLevel ? s.expandAll() : s.expandEverything(msg.messageId)); break;
    case 'smartExpand': await s.smartExpand(msg.messageId, msg.more, msg.view); break;
    case 'requestEntryPoints':
      try {
        const entryPoints = await s.getEntryPoints();
        const project = projectRoot.split('/').pop();
        return [{ type: 'entryPoints', entryPoints, project, tree: entryPointTree(entryPoints, project) }];
      } catch (e) {
        return [{ type: 'entryPoints', entryPoints: [], error: String(e) }];
      }
    case 'openMethod': await s.openMethodByKey(msg.methodKey, msg.entryPoint); break;
    case 'requestProjectFindings': {
      const findings = await s.findProjectIssues({ rescan: msg.rescan });
      return [{ type: 'projectFindings', state: findings ? 'done' : 'cancelled', findings, total: s.projectEntryPointCount, truncated: s.projectTruncatedCount, unreached: s.projectUnreachedCount, ...(s.projectFindingsChanged ? { changed: true } : {}), outcomes: s.entryOutcomes(), project: projectRoot.split('/').pop() }];
    }
    case 'cancelProjectFindings': return [];
    case 'requestUnreachable': {
      const r = await s.findUnreachableCode({ rescan: msg.rescan });
      return [r ? { type: 'unreachable', state: 'done', result: unreachableScan(r), project: projectRoot.split('/').pop() } : { type: 'unreachable', state: 'cancelled' }];
    }
    case 'cancelUnreachable': return [];
    case 'openFinding': {
      const d = await s.openFinding(msg.entryPoint);
      return d ? [render(), { type: 'highlight', messageId: msg.finding.messageIds?.[0] ?? null, messageIds: msg.finding.messageIds ?? [], finding: msg.finding }] : [render()];
    }
    case 'collapseAll': await s.collapseAll(); break;
    case 'collapseFragment': await s.collapseFragment(msg.fragmentId); break;
    case 'expandFragment': await s.expandFragment(msg.fragmentId); break;
    case 'followCase': await s.followCase(msg.fragmentId, msg.case); break;
    case 'showAllCases': await s.showAllCases(msg.fragmentId); break;
    case 'showErrorPath': await s.showErrorPath(msg.key); break;
    case 'selectImplementation': await s.selectImplementation(msg.messageId, msg.classKey); break;
    case 'revertImplementation': await s.revertImplementation(msg.messageId); break;
    case 'reroot': await s.reroot(msg.messageId, msg.callerId); break;
    case 'requestPaths': {
      const r = await s.findPathsToHere(msg.messageId);
      return [r ? { type: 'paths', messageId: msg.messageId, state: 'done', tree: r.tree, methods: r.methods, truncated: r.truncated } : { type: 'paths', messageId: msg.messageId, state: 'cancelled' }];
    }
    case 'cancelPaths': return [];
    case 'searchCollapsed': {
      const r = await s.searchCollapsed(msg.query, { deeper: msg.deeper });
      return [r ? { type: 'searchResults', query: msg.query, state: 'done', hits: r.hits, methods: r.methods, truncated: r.truncated, ...(msg.deeper ? { deeper: true } : {}) } : { type: 'searchResults', query: msg.query, state: 'cancelled' }];
    }
    case 'cancelSearch': return [];
    case 'searchMethods': return [{ type: 'methodResults', query: msg.query, ...(await s.searchMethods(msg.query)) }]; // FR-16.15
    case 'requestGitRefs': {
      try {
        return [{ type: 'gitRefs', refs: await s.gitRefs() }];
      } catch (e) {
        return [{ type: 'gitRefs', error: e instanceof Error ? e.message : String(e) }];
      }
    }
    case 'requestReview': {
      try {
        const result = await s.reviewChanges({ base: msg.base, force: msg.force, mode: msg.mode });
        return result ? [{ type: 'review', state: 'done', result }, { type: 'render', diagram: (await s.redraw())! }] : [{ type: 'review', state: 'cancelled' }];
      } catch (e) {
        return [{ type: 'review', state: 'error', error: e instanceof Error ? e.message : String(e) }];
      }
    }
    case 'cancelReview': return [];
    case 'openReviewIssue': {
      await s.openReviewFlow(msg.issue);
      return [render(), { type: 'highlight', messageId: msg.issue.finding.messageIds?.[0] ?? null, messageIds: msg.issue.finding.messageIds ?? [], finding: msg.issue.finding }];
    }
    case 'openReviewStructure': {
      const r = await s.openReviewStructure(msg.row);
      return r ? [render(), { type: 'highlight', messageId: r.messageId ?? null }] : [];
    }
    case 'endReview': await s.endReview(); break;
    case 'revealSearchHit': {
      const r = await s.revealSearchHit(msg.hit);
      return r ? [render(), { type: 'highlight', messageId: r.messageId }] : [];
    }
    case 'openPath': {
      const opened = await s.openPath(msg.steps, msg.entryPoint);
      return opened ? [render(), { type: 'highlight', messageId: opened.messageId }] : [render()];
    }
    case 'showChange':
    case 'revealChange':
    case 'openChangeFlow': {
      const r = msg.type === 'revealChange' ? await s.revealChange(msg.messageId) : msg.type === 'showChange' ? await s.showChange(msg.n) : await s.openChangeFlow(msg.paths, msg.entryPoint);
      return r ? [render(), { type: 'highlight', messageId: r.messageId }] : [];
    }
    case 'openDiff': return [];
    case 'copyState': { // FR-25.2 (the page copies the text)
      const state = await s.exportState({ language, tool: { host: 'devhost' } });
      return [state ? { type: 'diagramState', text: formatState(state), ...(msg.save ? { save: true, name: stateFileName(state) } : {}) } : { type: 'diagramState', error: 'No diagram to share.' }];
    }
    case 'copyText': { // FR-25.4 / FR-25.5 (the page copies the text)
      const d = s.current();
      const text = d && (msg.messageId ? askText(projectRoot, d, msg.messageId) : viewText(projectRoot, d));
      return [text ? { type: 'diagramText', text } : { type: 'diagramText', error: 'No diagram to copy.' }];
    }
    case 'openState': {
      try {
        const { report } = await s.restoreState(parseState(msg.text), { language });
        return [render(), { type: 'stateReport', report }];
      } catch (e) {
        return [{ type: 'stateReport', error: e instanceof Error ? e.message : String(e) }];
      }
    }
    case 'restoreSettings': await s.restoreSettings(); break;
    case 'useSharedConfig': {
      try {
        await s.useSharedConfig(msg.on);
      } catch (e) {
        return [{ type: 'stateReport', error: e instanceof Error ? e.message : String(e) }];
      }
      break;
    }
    case 'focus': await s.focus(msg.messageId); break;
    case 'hide': await s.hide(msg.filter); break;
    case 'unhide': await s.unhide(msg.filterId); break;
    case 'unhideAll': await s.unhideAll(); break;
    case 'back': await s.back(); break;
    case 'forward': await s.forward(); break;
    case 'setOption': await s.setOption(msg.option, msg.value as never); break;
    case 'setLayerOpen': await s.setLayerOpen(msg.layer, msg.open); break; // FR-28.7
    case 'foldLayers': await s.foldAllLayers(); break; // FR-28.9
    case 'savePositions': case 'openClassDiagram': case 'openAppMap': return [];
    case 'log': return []; // diagnostics only — a re-render would close open popups (callers panel)
    case 'requestLayerScopes': return [{ type: 'layerScopes', classKey: msg.classKey, scopes: layerScopes(projectRoot, msg.classKey, msg.className) }]; // FR-7.12
    case 'setLayer': {
      const rel = msg.match ?? relPathOfKey(msg.classKey);
      if (!rel) return [];
      const file = configFileOf(projectRoot);
      writeFileSync(file, setLayerRule(existsSync(file) ? readFileSync(file, 'utf8') : undefined, rel, msg.layer));
      await s.refresh([file.replace(/\\/g, '/')]);
      break;
    }
    case 'ignoreFinding':
    case 'ignoreLayerHint':
    case 'unignoreFinding':
    case 'unignoreLayerHint': {
      const file = configFileOf(projectRoot);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      const add = msg.type === 'ignoreFinding' ? addFindingIgnore : msg.type === 'ignoreLayerHint' ? addLayerHintIgnore : undefined;
      const out = add ? add(text, msg.pattern) : removeIgnore(text, msg.type === 'unignoreFinding' ? 'findings' : 'layerHints', msg.pattern);
      if (out !== undefined) writeFileSync(file, out);
      await s.refresh([file.replace(/\\/g, '/')]);
      break;
    }
  }
  // FR-17.5: no push channel — wait for the background I/O scan so the reply has the deep badges
  await session.scanSideEffects();
  return [render()];
}

const page = (entry: 'sequence' | 'class', engine?: string | null) => `<!DOCTYPE html><html><head><meta charset="UTF-8">
<link rel="stylesheet" href="/dist/styles.css"></head><body><div id="app"></div>
<script>${engine === 'elk' || engine === 'dagre' ? `window.__SEQCALL_ENGINE = '${engine}';` : ''}
  window.__seqcallHostPost = (msg) => fetch('/intent/${entry}', { method: 'POST', body: JSON.stringify(msg) })
    .then((r) => r.json()).then((out) => out.forEach((m) => window.postMessage(m, '*')));
</script>
<script src="/dist/${entry}.js"></script></body></html>`;

function send(res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}

async function classRender(): Promise<HostToClassView> {
  const d = await session.getClassDiagram();
  const seq = session.current();
  return d
    ? { type: 'render', diagram: d, hiddenFilters: seq?.hiddenFilters, ...(seq ? { options: seq.options } : {}), rootClassKey: seq?.root.owner.key, layerChoices: seq?.layerChoices, ...(seq?.borrowedConfig ? { borrowedConfig: seq.borrowedConfig } : {}) }
    : { type: 'empty', reason: 'No sequence diagram.' };
}

const fail = (res: ServerResponse, e: unknown): void => {
  if (!res.headersSent) res.writeHead(500);
  res.end(String(e));
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  try {
    if (url.pathname === '/sequence' || url.pathname === '/class') {
      const file = url.searchParams.get('file');
      const entry = url.searchParams.get('entry');
      if (file || entry) {
        if (entry) {
          const all = await session.getEntryPoints();
          const e = all.find((x) => x.label === entry) ?? all.find((x) => x.label.includes(entry));
          if (!e) throw new Error(`no entry point like ${entry}`);
          await session.openMethodByKey(e.method.key, e);
        } else await session.openAt(join(projectRoot, file!).replace(/\\/g, '/'), { line: Number(url.searchParams.get('line') ?? 1) - 1, character: 4 });
        for (const a of (url.searchParams.get('actions') ?? '').split(',').filter(Boolean)) await replay(a);
        await session.scanSideEffects();
      }
      return send(res, 'text/html', page(url.pathname.slice(1) as 'sequence' | 'class', url.searchParams.get('engine')));
    }
    if (url.pathname.startsWith('/dist/')) {
      const name = url.pathname.slice('/dist/'.length).replace(/[^\w.-]/g, '');
      return send(res, name.endsWith('.css') ? 'text/css' : 'text/javascript', readFileSync(join(webviewDist, name), 'utf8'));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/intent/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const msg = JSON.parse(body);
          let out: unknown[];
          if (url.pathname.endsWith('/class')) {
            const rerender = msg.type === 'setOption' || msg.type === 'setLayerOpen' || msg.type === 'foldLayers' || msg.type === 'ready' || msg.type === 'hide' || msg.type === 'unhide' || msg.type === 'unhideAll' || msg.type === 'setTypeUses' || msg.type === 'focus' || CONFIG_IGNORES.has(msg.type) || msg.type === 'revealRelation';
            if (msg.type === 'hide' || msg.type === 'unhide' || msg.type === 'unhideAll' || msg.type === 'focus' || CONFIG_IGNORES.has(msg.type)) await handle(msg);
            if (msg.type === 'setTypeUses') await session.setOption('showTypeUses', !!msg.value); // FR-12.12
            // FR-25.2 / FR-25.3 the flow's state (a report goes to the sequence page, not pushed here)
            if (msg.type === 'copyState') return send(res, 'application/json', JSON.stringify(await handle(msg)));
            if (msg.type === 'copyText') { // FR-25.4 the classes as text (the page copies it)
              const d = await session.getClassDiagram();
              const seq = session.current();
              return send(res, 'application/json', JSON.stringify([d && seq ? { type: 'diagramText', text: classViewText(projectRoot, d, seq) } : { type: 'diagramText', error: 'No diagram to copy.' }]));
            }
            if (msg.type === 'openState' || msg.type === 'useSharedConfig') {
              const r = await handle(msg);
              const err = r.find((m) => m.type === 'stateReport' && m.error);
              return send(res, 'application/json', JSON.stringify(err ? [err] : [await classRender()]));
            }
            if (msg.type === 'setOption' || msg.type === 'setLayerOpen' || msg.type === 'foldLayers') await handle(msg); // / FR-28.7 (the sequence page shows it on its next load)
            if (msg.type === 'openFinding') await handle(msg); // the sequence page shows it on its next load
            if (msg.type === 'revealRelation') await session.revealRelation(msg.from, msg.to, msg.field); // FR-12.14 (no push to the sequence page)
            // FR-26 the codebase map (scanned once, cached by the session)
            if (msg.type === 'requestAppMap') {
              const level = await session.getAppMap(msg.path ?? '', { rescan: !!msg.rescan, open: msg.open, entryPoints: msg.entryPoints });
              return send(res, 'application/json', JSON.stringify([level ? { type: 'appMap', state: 'done', level } : { type: 'appMap', state: 'cancelled' }]));
            }
            out = rerender ? [await classRender()] : msg.type === 'requestLayerScopes' ? [{ type: 'layerScopes', classKey: msg.classKey, scopes: layerScopes(projectRoot, msg.classKey, msg.className) }] : [];
          } else out = await handle(msg);
          send(res, 'application/json', JSON.stringify(out));
        } catch (e) {
          fail(res, e);
        }
      });
      return;
    }
    res.writeHead(404).end();
  } catch (e) {
    fail(res, e);
  }
}).listen(port, () => console.log(`devhost (${language}): ${projectRoot} on http://localhost:${port}/sequence?file=...&line=...`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all([adapter.dispose(), session.dispose()]).finally(() => process.exit(0));
  });
}
