// tokenExtractor.ts — all async (required: documentAccess: dynamic-page)
import { ColorToken } from './colorMatcher';

type RGBValue = { r: number; g: number; b: number };
const _resolveCache = new Map<string, RGBValue | null>();

function resolveColorFromMap(varId: string, map: Map<string, Variable>, depth = 0): RGBValue | null {
  if (depth > 8) return null;
  if (_resolveCache.has(varId)) return _resolveCache.get(varId)!;
  const v = map.get(varId);
  if (!v || v.resolvedType !== 'COLOR') { _resolveCache.set(varId, null); return null; }
  const modeIds = Object.keys(v.valuesByMode);
  if (!modeIds.length) { _resolveCache.set(varId, null); return null; }
  for (const modeId of modeIds) {
    const val = v.valuesByMode[modeId];
    if (!val || typeof val !== 'object') continue;
    if ('r' in val && 'g' in val && 'b' in val) {
      const rgb = { r: (val as RGB).r, g: (val as RGB).g, b: (val as RGB).b };
      _resolveCache.set(varId, rgb); return rgb;
    }
    if ('type' in val && (val as VariableAlias).type === 'VARIABLE_ALIAS') {
      const resolved = resolveColorFromMap((val as VariableAlias).id, map, depth + 1);
      if (resolved) { _resolveCache.set(varId, resolved); return resolved; }
    }
  }
  _resolveCache.set(varId, null); return null;
}

export async function extractLocalColorTokensAsync(): Promise<ColorToken[]> {
  _resolveCache.clear(); // clear cache on fresh extraction
  const tokens: ColorToken[] = [];
  const seen = new Set<string>();
  try {
    const allColorVars = await figma.variables.getLocalVariablesAsync('COLOR');
    const varMap = new Map<string, Variable>();
    for (const v of allColorVars) varMap.set(v.id, v);
    try { const all = await figma.variables.getLocalVariablesAsync(); for (const v of all) if (!varMap.has(v.id)) varMap.set(v.id, v); } catch (_) {}
    for (const v of allColorVars) {
      if (seen.has(v.id)) continue;
      const color = resolveColorFromMap(v.id, varMap);
      if (!color) continue;
      seen.add(v.id);
      tokens.push({ name: v.name, variableId: v.id, rgb: color, collectionName: v.name.split('/')[0] || '' });
    }
    console.log('[TD] Loaded', tokens.length, 'color tokens');
  } catch (e) { console.warn('[TD] getLocalVariablesAsync:', e instanceof Error ? e.message : e); }
  try {
    const styles = await figma.getLocalPaintStylesAsync();
    for (const s of styles) {
      if (seen.has(s.id)) continue;
      const solid = s.paints.find((p): p is SolidPaint => p.type === 'SOLID');
      if (solid) {
        seen.add(s.id);
        tokens.push({ name: s.name, variableId: s.id, rgb: { r: solid.color.r, g: solid.color.g, b: solid.color.b }, collectionName: 'Paint Styles' });
      }
    }
  } catch (e) { console.warn('[TD] getLocalPaintStylesAsync:', e instanceof Error ? e.message : e); }
  return tokens;
}

export interface LibraryTokenInfo { key: string; name: string; collectionName: string; resolvedDataType: string; }

export async function extractLibraryColorTokensAsync(): Promise<LibraryTokenInfo[]> {
  const result: LibraryTokenInfo[] = [];
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    for (const col of collections) {
      try {
        const vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const v of vars) if (v.resolvedType === 'COLOR')
          result.push({ key: v.key, name: v.name, collectionName: col.name, resolvedDataType: v.resolvedType });
      } catch (_) {}
    }
  } catch (_) {}
  return result;
}

export async function importLibraryVariableAsync(key: string): Promise<ColorToken | null> {
  try {
    const v = await figma.variables.importVariableByKeyAsync(key);
    if (!v || v.resolvedType !== 'COLOR') return null;
    const varMap = new Map<string, Variable>(); varMap.set(v.id, v);
    const color = resolveColorFromMap(v.id, varMap);
    if (!color) return null;
    return { name: v.name, variableId: v.id, rgb: color, collectionName: v.name.split('/')[0] || '' };
  } catch (_) { return null; }
}

export interface TextStyleToken { id: string; name: string; fontFamily: string; fontStyle: string; fontSize: number; }

export async function extractLocalTextStylesAsync(): Promise<TextStyleToken[]> {
  const result: TextStyleToken[] = [];
  try {
    const styles = await figma.getLocalTextStylesAsync();
    for (const s of styles)
      result.push({ id: s.id, name: s.name, fontFamily: s.fontName.family, fontStyle: s.fontName.style, fontSize: s.fontSize });
    console.log('[TD] Loaded', result.length, 'text styles');
  } catch (e) { console.warn('[TD] getLocalTextStylesAsync:', e instanceof Error ? e.message : e); }
  return result;
}

// ── Text style matching — SIZE FIRST, weight second, names last ─────────────
//
// A loose "14 Semibold" must snap to the nearest 14px style (preferring the
// closest weight), never to a 24px style that happens to be named "button".
// Hierarchical scoring: 1px of size difference outweighs ANY name/weight
// signal; weight distance outweighs family/name signals.

const MAX_TEXT_SIZE_DIFF = 4; // px — beyond this there is no honest match

function styleWeightNum(style: string): number {
  const l = (style || '').toLowerCase();
  if (l.includes('hairline') || l.includes('thin')) return 100;
  if (l.includes('extralight') || l.includes('extra light') || l.includes('ultralight')) return 200;
  if (l.includes('semibold') || l.includes('semi bold') || l.includes('demi')) return 600;
  if (l.includes('extrabold') || l.includes('extra bold') || l.includes('ultrabold')) return 800;
  if (l.includes('light')) return 300;
  if (l.includes('medium')) return 500;
  if (l.includes('black') || l.includes('heavy')) return 900;
  if (l.includes('bold')) return 700;
  const m = l.match(/\b([1-9]00)\b/);
  if (m) return parseInt(m[1], 10);
  return 400;
}

export function findClosestTextStyle(
  fontFamily: string, fontStyle: string, fontSize: number,
  styles: TextStyleToken[],
  componentContext = ''
): (TextStyleToken & { score: number }) | null {
  if (!styles.length) return null;

  const targetWeight = styleWeightNum(fontStyle);
  const contextBoost: Record<string, string[]> = {
    button: ['button','btn','cta','action'],
    chip:   ['chip','tag','badge','pill'],
    input:  ['input','field','placeholder','form','helper'],
    nav:    ['nav','navigation','menu','link'],
    card:   ['card','title','subtitle','body'],
    modal:  ['modal','dialog','heading','title'],
    toast:  ['toast','notification','alert','snackbar'],
    tab:    ['tab','navigation'],
  };
  const boostWords = contextBoost[componentContext] || [];

  let best: (TextStyleToken & { score: number }) | null = null;
  for (const s of styles) {
    const sizeDiff = Math.abs(s.fontSize - fontSize);
    if (sizeDiff > MAX_TEXT_SIZE_DIFF) continue; // hard gate: wrong size = no match

    const candWeight = styleWeightNum(s.fontStyle);
    const weightDiff = Math.abs(candWeight - targetWeight);

    // Hierarchical: size (×1000) ≫ weight (×1) ≫ family (200) ≫ exact style (50) ≫ context (25)
    let score = 10000 - sizeDiff * 1000 - weightDiff;
    // Equidistant weights (e.g. Semibold between Medium and Bold): prefer the
    // heavier one — keeping emphasis beats losing it.
    if (candWeight >= targetWeight) score += 5;
    if (s.fontFamily.toLowerCase() === fontFamily.toLowerCase()) score += 200;
    if (s.fontStyle.toLowerCase() === fontStyle.toLowerCase()) score += 50;
    if (boostWords.length > 0 && boostWords.some(w => s.name.toLowerCase().includes(w))) score += 25;

    if (!best || score > best.score) best = { ...s, score };
  }
  return best; // null when nothing is within 4px — flag for manual pick
}
