import htmlContent from './ui.html';
import { traverseForOrphans, OrphanColor, OrphanText, TraversalStats, BoundUsage } from './utils/nodeTraverser';
import { extractLocalColorTokensAsync, extractLibraryColorTokensAsync, importLibraryVariableAsync, extractLocalTextStylesAsync, findClosestTextStyle, TextStyleToken, LibraryTokenInfo } from './utils/tokenExtractor';
import { rgbToHex, colorDistance, ColorToken } from './utils/colorMatcher';
import { buildDesignSystemIndex, detectSemanticRole, findSemanticMatches, DesignSystemIndex, UsagePattern } from './utils/semanticEngine';

figma.showUI(htmlContent, { width: 500, height: 680, themeColors: false, title: 'Token Ninja' });

let allColorTokens: ColorToken[] = [];
let textStyleTokens: TextStyleToken[] = [];
let dsIndex: DesignSystemIndex = { categories: new Map(), allSemantic: [], allTokens: [] };
let usagePatterns: UsagePattern[] = [];

// Learned mappings: when the user manually picks a token for a hex via
// "Choose", remember it and rank it first on every future scan.
interface LearnedPick { tokenId: string; tokenName: string; count: number; }
let learnedMap: Record<string, LearnedPick> = {};

// Auto-scan: scan automatically when the user selects a top-level frame.
let autoScan = false;
let suppressAutoUntil = 0;
let autoTimer: ReturnType<typeof setTimeout> | undefined;

function isPrimitive(t: ColorToken) { return (t.collectionName || '').toLowerCase().includes('primitive'); }

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  figma.ui.postMessage({ type: 'LOADING_START' });

  try {
    const [savedAuto, savedLearned] = await Promise.all([
      figma.clientStorage.getAsync('tn-autoscan'),
      figma.clientStorage.getAsync('tn-learned')
    ]);
    autoScan = savedAuto === true;
    if (savedLearned && typeof savedLearned === 'object') learnedMap = savedLearned as Record<string, LearnedPick>;
  } catch (_) {}
  figma.ui.postMessage({ type: 'SETTINGS', autoScan });

  const [local, textStyles] = await Promise.all([
    extractLocalColorTokensAsync(),
    extractLocalTextStylesAsync()
  ]);
  allColorTokens = local;
  textStyleTokens = textStyles;
  dsIndex = buildDesignSystemIndex(local);
  console.log('[TN] DS Index built:', dsIndex.categories.size, 'categories,', dsIndex.allSemantic.length, 'semantic tokens');
  
  figma.ui.postMessage({
    type: 'TOKENS_LOADED',
    tokens: local.map((t: ColorToken) => ({
      id: t.variableId, name: t.name, hex: rgbToHex(t.rgb),
      isLibrary: false, collectionName: t.collectionName || ''
    })),
    textStyles: textStyleTokens
  });
  const libInfos = await extractLibraryColorTokensAsync();
  figma.ui.postMessage({
    type: 'LIBRARY_NAMES_LOADED',
    libraryTokens: libInfos.map((l: LibraryTokenInfo) => ({
      id: l.key, name: l.name, hex: null, isLibrary: true, collectionName: l.collectionName
    }))
  });
})();

interface ApplyItem { nodeId: string; tokenId: string; isLibrary: boolean; fillIndex: number; propertyType: 'fill'|'stroke'; }

// Remembered roots of the last scan — lets the user hit "Rescan" mid-fixing
// without having to re-select the frame on canvas.
let lastScanRootIds: string[] = [];
let lastScanRootName = '';

async function runScan(roots: readonly SceneNode[]): Promise<void> {
    lastScanRootIds = roots.map(n => n.id);
    lastScanRootName = roots.length === 1 ? roots[0].name : roots.length + ' frames';

    const orphanColors: OrphanColor[] = [], orphanTexts: OrphanText[] = [];
    const boundUsages: BoundUsage[] = [];
    const stats: TraversalStats = { totalColorFills: 0, totalTextNodes: 0 };
    for (const node of roots) traverseForOrphans(node, orphanColors, orphanTexts, stats, boundUsages);

    // Rebuild DS index (in case tokens changed)
    dsIndex = buildDesignSystemIndex(allColorTokens);

    // ── PATTERN LEARNING ───────────────────────────────────────────────────
    // Layers already bound to variables ARE this file's conventions — learn
    // which token is used in which component context and boost accordingly.
    const patMap = new Map<string, { contexts: Set<string>; count: number }>();
    for (const u of boundUsages) {
      const role = detectSemanticRole(u.nodeName, u.nodeType, u.parentName, u.ancestorName, u.propertyType);
      let p = patMap.get(u.variableId);
      if (!p) { p = { contexts: new Set<string>(), count: 0 }; patMap.set(u.variableId, p); }
      p.contexts.add(role.component);
      p.count++;
    }
    usagePatterns = [];
    patMap.forEach((p, tokenId) => {
      usagePatterns.push({ tokenId, tokenName: '', contexts: Array.from(p.contexts), nodeTypes: [], count: p.count });
    });
    console.log('[TN] Learned', usagePatterns.length, 'usage pattern(s) from', boundUsages.length, 'bound layer(s)');

    // ── SEMANTIC MATCHING (memoized per hex + role) ────────────────────────
    const matchCache = new Map<string, ReturnType<typeof findSemanticMatches>>();
    const colorItems = orphanColors.map(o => {
      const role = detectSemanticRole(o.nodeName, o.nodeType, o.parentName, o.ancestorName, o.propertyType);
      const cacheKey = rgbToHex({ r: o.r, g: o.g, b: o.b }) + '|' + role.category + '|' + role.component + '|' + role.inferredRole;
      let candidates = matchCache.get(cacheKey);
      if (!candidates) {
        candidates = findSemanticMatches({ r: o.r, g: o.g, b: o.b }, role, dsIndex, usagePatterns, 3);
        matchCache.set(cacheKey, candidates);
      }
      const best = candidates[0] || null;
      
      return {
        nodeId: o.nodeId, nodeName: o.nodeName, nodeType: o.nodeType,
        parentName: o.parentName, ancestorName: o.ancestorName,
        propertyType: o.propertyType, fillIndex: o.fillIndex, opacity: o.opacity,
        rgb: { r: o.r, g: o.g, b: o.b },
        currentHex: rgbToHex({ r: o.r, g: o.g, b: o.b }),
        context: role.inferredRole,
        component: role.component,
        category: role.category,
        suggestion: best ? {
          tokenId: best.token.variableId,
          tokenName: best.token.name,
          hex: rgbToHex(best.token.rgb),
          distance: best.deltaE,
          confidence: best.confidence,
          isLibrary: false,
          crossCategory: false,
          reasons: best.reasons.slice(0, 2)
        } : null,
        alternates: candidates.slice(1).map(c => ({
          tokenId: c.token.variableId,
          tokenName: c.token.name,
          hex: rgbToHex(c.token.rgb),
          confidence: c.confidence
        }))
      };
    });

    // Group by hex
    const hexMap = new Map<string, typeof colorItems>();
    for (const item of colorItems) {
      if (!hexMap.has(item.currentHex)) hexMap.set(item.currentHex, []);
      hexMap.get(item.currentHex)!.push(item);
    }
    const colorGroups = Array.from(hexMap.entries()).map(([hex, instances]) => {
      const best = instances.reduce((a, b) =>
        (b.suggestion?.confidence ?? 0) > (a.suggestion?.confidence ?? 0) ? b : a);
      return {
        hex, count: instances.length,
        context: best.context, component: best.component, category: best.category,
        nodeName: best.nodeName, nodeType: best.nodeType,
        instances: instances.map(i => ({ nodeId: i.nodeId, fillIndex: i.fillIndex, propertyType: i.propertyType })),
        suggestion: best.suggestion,
        alternates: best.alternates || [],
        rgb: best.rgb
      };
    });

    // ── LEARNED PICKS ──────────────────────────────────────────────────────
    // If the user manually mapped this exact hex to a token before, rank that
    // token first — their explicit choice beats any heuristic.
    for (const g of colorGroups) {
      const learned = learnedMap[g.hex];
      if (!learned) continue;
      const tok = allColorTokens.find(t => t.variableId === learned.tokenId)
        || allColorTokens.find(t => t.name === learned.tokenName);
      if (!tok) continue;
      const de = Math.round(colorDistance(g.rgb, tok.rgb) * 10) / 10;
      g.suggestion = {
        tokenId: tok.variableId, tokenName: tok.name, hex: rgbToHex(tok.rgb),
        distance: de, confidence: 96, isLibrary: false, crossCategory: false,
        reasons: ['You picked this token for ' + g.hex + ' before' + (learned.count > 1 ? ' (' + learned.count + '×)' : '')]
      };
    }

    colorGroups.sort((a, b) => (b.suggestion?.confidence ?? 0) - (a.suggestion?.confidence ?? 0));

    // ── TEXT STYLE MATCHING ─────────────────────────────────────────────────
    const textResults = orphanTexts.map(t => {
      const role = detectSemanticRole(t.nodeName, 'TEXT', t.parentName, t.ancestorName, 'fill');
      const match = findClosestTextStyle(t.fontFamily, t.fontStyle, t.fontSize, textStyleTokens, role.component);
      return {
        nodeId: t.nodeId, nodeName: t.nodeName, parentName: t.parentName, ancestorName: t.ancestorName,
        fontFamily: t.fontFamily, fontStyle: t.fontStyle, fontSize: t.fontSize,
        componentContext: role.component, inferredRole: role.inferredRole,
        suggestion: match ? {
          styleId: match.id, styleName: match.name,
          fontFamily: match.fontFamily, fontStyle: match.fontStyle, fontSize: match.fontSize
        } : null
      };
    });

    // Health score
    const cH = stats.totalColorFills > 0 ? Math.round((stats.totalColorFills - orphanColors.length) / stats.totalColorFills * 100) : 100;
    const tH = stats.totalTextNodes > 0 ? Math.round((stats.totalTextNodes - orphanTexts.length) / stats.totalTextNodes * 100) : 100;
    const overall = stats.totalColorFills + stats.totalTextNodes > 0
      ? Math.round((cH * stats.totalColorFills + tH * stats.totalTextNodes) / (stats.totalColorFills + stats.totalTextNodes)) : 100;

    figma.ui.postMessage({
      type: 'SCAN_RESULTS', colorGroups, orphanTexts: textResults,
      totalColorNodes: orphanColors.length, totalTextNodes: stats.totalTextNodes,
      totalColorFills: stats.totalColorFills,
      tokenCount: allColorTokens.length, textStyleCount: textStyleTokens.length,
      scannedName: lastScanRootName,
      health: { overall, colorHealth: cH, textHealth: tH, totalColorFills: stats.totalColorFills, totalTextNodes: stats.totalTextNodes }
    });
}

async function rescanLast(): Promise<boolean> {
  const roots: SceneNode[] = [];
  for (const id of lastScanRootIds) {
    try {
      const n = await figma.getNodeByIdAsync(id);
      if (n && n.type !== 'DOCUMENT' && n.type !== 'PAGE') roots.push(n as SceneNode);
    } catch (_) {}
  }
  if (!roots.length) return false;
  await runScan(roots);
  return true;
}

// ── AUTO-SCAN: selecting a top-level frame triggers a scan automatically ──────
figma.on('selectionchange', () => {
  if (!autoScan) return;
  if (Date.now() < suppressAutoUntil) return; // our own HIGHLIGHT_NODE selection
  const roots = figma.currentPage.selection.filter(n =>
    n.parent != null && (n.parent.type === 'PAGE' || n.parent.type === 'SECTION'));
  if (!roots.length) return;
  const ids = roots.map(n => n.id).join(',');
  if (ids === lastScanRootIds.join(',')) return; // already scanned these roots
  if (autoTimer !== undefined) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    figma.ui.postMessage({ type: 'AUTO_SCAN_START' });
    runScan(roots).catch(() => {});
  }, 500);
});

// ── HOVER PREVIEW: temporarily paint the suggestion on canvas ─────────────────
const previewBackup = new Map<string, readonly Paint[]>();

async function previewColor(instances: ApplyItem[], tokenId: string): Promise<void> {
  let variable: Variable | null = null;
  try { variable = await figma.variables.getVariableByIdAsync(tokenId); } catch (_) {}
  if (!variable) return;
  for (const it of instances) {
    try {
      const node = await figma.getNodeByIdAsync(it.nodeId) as SceneNode | null;
      if (!node) continue;
      const propKey = it.propertyType === 'fill' ? 'fills' : 'strokes';
      if (!(propKey in node)) continue;
      const cur = (node as unknown as Record<string, unknown>)[propKey];
      if (cur === figma.mixed || !Array.isArray(cur)) continue;
      const paints = cur as readonly Paint[];
      if (!paints[it.fillIndex] || paints[it.fillIndex].type !== 'SOLID') continue;
      const key = it.nodeId + '|' + it.propertyType;
      if (!previewBackup.has(key)) previewBackup.set(key, paints);
      const m = paints.map((p): Paint => ({ ...p } as Paint));
      m[it.fillIndex] = figma.variables.setBoundVariableForPaint(m[it.fillIndex] as SolidPaint, 'color', variable);
      (node as unknown as Record<string, unknown>)[propKey] = m;
    } catch (_) {}
  }
}

async function clearPreview(): Promise<void> {
  for (const entry of Array.from(previewBackup.entries())) {
    try {
      const sep = entry[0].lastIndexOf('|');
      const nodeId = entry[0].slice(0, sep), prop = entry[0].slice(sep + 1);
      const node = await figma.getNodeByIdAsync(nodeId) as SceneNode | null;
      if (!node) continue;
      const propKey = prop === 'fill' ? 'fills' : 'strokes';
      if (propKey in node) (node as unknown as Record<string, unknown>)[propKey] = entry[1];
    } catch (_) {}
  }
  previewBackup.clear();
}

figma.ui.onmessage = async (msg: Record<string, unknown>) => {
  const type = msg.type as string;

  // ── SCAN ─────────────────────────────────────────────────────────────────────
  if (type === 'SCAN_SELECTION') {
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'ERROR', message: 'Select a frame first.' }); return; }
    await runScan(sel);
  }

  // ── RESCAN (same roots as last scan, even if deselected) ──────────────────────
  if (type === 'RESCAN') {
    if (await rescanLast()) return;
    const sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'ERROR', message: 'Nothing to rescan — select a frame first.' }); return; }
    await runScan(sel);
  }

  // ── SETTINGS ──────────────────────────────────────────────────────────────────
  if (type === 'SET_AUTOSCAN') {
    autoScan = msg.value === true;
    figma.clientStorage.setAsync('tn-autoscan', autoScan).catch(() => {});
  }

  // ── HOVER PREVIEW ─────────────────────────────────────────────────────────────
  if (type === 'PREVIEW_COLOR') {
    await previewColor(msg.instances as ApplyItem[], msg.tokenId as string);
  }
  if (type === 'PREVIEW_CLEAR') {
    await clearPreview();
  }

  // ── HIGHLIGHT ──────────────────────────────────────────────────────────────
  if (type === 'HIGHLIGHT_NODE') {
    try {
      suppressAutoUntil = Date.now() + 1200; // don't auto-scan our own selection
      const node = await figma.getNodeByIdAsync(msg.nodeId as string);
      if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
        figma.currentPage.selection = [node as SceneNode];
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      }
    } catch (_) {}
  }

  // ── APPLY GROUP ────────────────────────────────────────────────────────────
  if (type === 'APPLY_GROUP') {
    const instances = msg.instances as ApplyItem[];
    const tokenId = msg.tokenId as string; const isLibrary = msg.isLibrary as boolean;
    // Applied paints must survive an in-flight hover preview revert
    for (const item of instances) previewBackup.delete(item.nodeId + '|' + item.propertyType);
    let ok = 0;
    for (const item of instances) {
      try { await applyColor(item.nodeId, tokenId, isLibrary, item.fillIndex, item.propertyType); ok++; } catch (_) {}
    }
    // Manual pick via "Choose" → learn this hex → token mapping for next time
    if (msg.manual === true && ok > 0 && typeof msg.hex === 'string') {
      const tok = allColorTokens.find(t => t.variableId === tokenId);
      const prev = learnedMap[msg.hex];
      learnedMap[msg.hex] = {
        tokenId,
        tokenName: tok ? tok.name : (prev ? prev.tokenName : ''),
        count: prev ? prev.count + 1 : 1
      };
      figma.clientStorage.setAsync('tn-learned', learnedMap).catch(() => {});
    }
    figma.ui.postMessage({ type: 'GROUP_APPLIED', hex: msg.hex, nodeIds: instances.map(i => i.nodeId), count: ok });
  }

  if (type === 'APPLY_TOKEN') {
    const i = msg as unknown as ApplyItem;
    try {
      await applyColor(i.nodeId, i.tokenId, i.isLibrary, i.fillIndex, i.propertyType);
      figma.ui.postMessage({ type: 'APPLY_SUCCESS', nodeId: i.nodeId, fillIndex: i.fillIndex, propertyType: i.propertyType });
    } catch (e) {
      figma.ui.postMessage({ type: 'APPLY_ERROR', nodeId: i.nodeId, fillIndex: i.fillIndex, propertyType: i.propertyType, message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (type === 'APPLY_TEXT_STYLE') {
    const nodeId = msg.nodeId as string, styleId = msg.styleId as string;
    try {
      await applyText(nodeId, styleId);
      figma.ui.postMessage({ type: 'APPLY_SUCCESS', nodeId, fillIndex: 0, propertyType: 'text' });
    } catch (e) {
      figma.ui.postMessage({ type: 'APPLY_ERROR', nodeId, fillIndex: 0, propertyType: 'text', message: e instanceof Error ? e.message : String(e) });
    }
  }

  if (type === 'APPLY_ALL_SAFE') {
    const groups = msg.groups as Array<{ hex: string; instances: ApplyItem[]; tokenId: string; isLibrary: boolean; confidence: number }>;
    previewBackup.clear();
    let ok = 0;
    for (const g of groups.filter(g => g.confidence >= 95)) {
      for (const item of g.instances) {
        try { await applyColor(item.nodeId, g.tokenId, g.isLibrary, item.fillIndex, item.propertyType); ok++; } catch (_) {}
      }
    }
    figma.commitUndo();
    figma.ui.postMessage({ type: 'APPLY_ALL_DONE', successCount: ok, errors: [], context: 'color' });
    await rescanLast(); // refresh counts with ground truth after a bulk apply
  }

  if (type === 'APPLY_ALL_TEXT') {
    const items = msg.items as Array<{nodeId:string;styleId:string}>;
    let ok = 0;
    for (const item of items) { try { await applyText(item.nodeId, item.styleId); ok++; } catch (_) {} }
    figma.commitUndo();
    figma.ui.postMessage({ type: 'APPLY_ALL_DONE', successCount: ok, errors: [], context: 'text' });
    await rescanLast();
  }

  if (type === 'IMPORT_LIBRARY_TOKENS') {
    const keys = msg.keys as string[]; let imported = 0;
    for (const key of keys) {
      const t = await importLibraryVariableAsync(key);
      if (t && !allColorTokens.find(x => x.variableId === t.variableId)) { allColorTokens.push(t); imported++; }
      figma.ui.postMessage({ type: 'IMPORT_PROGRESS', done: imported, total: keys.length });
    }
    dsIndex = buildDesignSystemIndex(allColorTokens); // rebuild index
    figma.ui.postMessage({ type: 'IMPORT_DONE', importedCount: imported, tokens: allColorTokens.map((t:ColorToken) => ({ id:t.variableId,name:t.name,hex:rgbToHex(t.rgb),isLibrary:false,collectionName:t.collectionName||'' })) });
  }

  if (type === 'REFRESH_TOKENS') {
    const [local, ts] = await Promise.all([extractLocalColorTokensAsync(), extractLocalTextStylesAsync()]);
    allColorTokens = local; textStyleTokens = ts;
    dsIndex = buildDesignSystemIndex(local);
    figma.ui.postMessage({ type: 'TOKENS_LOADED', tokens: local.map((t:ColorToken) => ({ id:t.variableId,name:t.name,hex:rgbToHex(t.rgb),isLibrary:false,collectionName:t.collectionName||'' })), textStyles: ts });
  }

  if (type === 'CLOSE') figma.closePlugin();
};

async function applyColor(nodeId:string, tokenId:string, isLibrary:boolean, fillIndex:number, propertyType:'fill'|'stroke'): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId) as SceneNode|null;
  if (!node) throw new Error('Node not found.');
  let variable: Variable|null = null;
  try { variable = await figma.variables.getVariableByIdAsync(tokenId); } catch (_) {}
  if (!variable && isLibrary) { try { variable = await figma.variables.importVariableByKeyAsync(tokenId); } catch (_) {} }
  if (variable) {
    if (propertyType === 'fill' && 'fills' in node) {
      const f = node.fills; if (f === figma.mixed) throw new Error('Mixed fills.');
      const fills = f as readonly Paint[];
      if (fillIndex >= fills.length) throw new Error('Fill index out of range.');
      if (fills[fillIndex].type !== 'SOLID') throw new Error('Not a solid fill.');
      const m = fills.map((p):Paint => ({...p} as Paint));
      m[fillIndex] = figma.variables.setBoundVariableForPaint(m[fillIndex] as SolidPaint, 'color', variable);
      (node as unknown as {fills:Paint[]}).fills = m; return;
    }
    if (propertyType === 'stroke' && 'strokes' in node) {
      const raw = (node as GeometryMixin).strokes as readonly Paint[];
      const m = raw.map((p):Paint => ({...p} as Paint));
      m[fillIndex] = figma.variables.setBoundVariableForPaint(m[fillIndex] as SolidPaint, 'color', variable);
      (node as unknown as {strokes:Paint[]}).strokes = m; return;
    }
    throw new Error(`Node doesn't support ${propertyType}.`);
  }
  let style:BaseStyle|null = null;
  try { style = await figma.getStyleByIdAsync(tokenId); } catch (_) {}
  if (style?.type === 'PAINT') {
    if (propertyType === 'fill' && 'fillStyleId' in node) { (node as unknown as {fillStyleId:string}).fillStyleId = tokenId; return; }
    if (propertyType === 'stroke' && 'strokeStyleId' in node) { (node as unknown as {strokeStyleId:string}).strokeStyleId = tokenId; return; }
  }
  throw new Error(`Token "${tokenId}" not found.`);
}

async function applyText(nodeId:string, styleId:string): Promise<void> {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node || node.type !== 'TEXT') throw new Error('Text node not found.');
  const t = node as TextNode;
  const fonts = t.getRangeAllFontNames(0, t.characters.length);
  for (const font of fonts) await figma.loadFontAsync(font);
  await (t as unknown as {setTextStyleIdAsync(id:string):Promise<void>}).setTextStyleIdAsync(styleId);
}
