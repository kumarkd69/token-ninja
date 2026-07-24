// ─────────────────────────────────────────────────────────────────────────────
// semanticEngine.ts — Smart Semantic Matching Engine
//
// Phase 1: Builds a Design System Index from local variables
// Phase 2: Learns patterns from already-bound nodes in the file
// Phase 3: Infers semantic intent from node context
// Phase 4: Multi-factor scoring (semantic role 40%, context 20%, visual 15%, 
//          typography 15%, hierarchy 5%, pattern 5%)
// ─────────────────────────────────────────────────────────────────────────────
import { ColorToken, RGBColor, colorDistance, chromaHue, hueDiff } from './colorMatcher';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SemanticRole {
  category: string;    // text | background | action | icon | border | status | surface | overlay | link
  component: string;   // button | chip | input | card | nav | modal | toast | tab | badge | general
  property: string;    // fill | stroke | text-fill | placeholder | icon-fill
  inferredRole: string; // e.g. "text/secondary", "action/primary", "icon/disabled"
}

export interface MatchCandidate {
  token: ColorToken;
  confidence: number;
  deltaE: number;
  reasons: string[];
  scores: {
    semantic: number;   // 0-100
    context: number;    // 0-100
    visual: number;     // 0-100 (deltaE inverted)
    pattern: number;    // 0-100
    hierarchy: number;  // 0-100
  };
}

// ── Design System Index ──────────────────────────────────────────────────────
// Groups tokens by their semantic category for fast lookup

export interface DesignSystemIndex {
  categories: Map<string, ColorToken[]>;  // 'text' → [tokens...], 'background' → [...]
  allSemantic: ColorToken[];              // non-primitive tokens
  allTokens: ColorToken[];                // everything
}

export function buildDesignSystemIndex(tokens: ColorToken[]): DesignSystemIndex {
  const categories = new Map<string, ColorToken[]>();
  const allSemantic: ColorToken[] = [];

  const categoryPatterns: Array<[RegExp, string]> = [
    [/^01-text|^text[/]|^typography[/]|^label[/]|^heading[/]|^body[/]|^caption[/]/i, 'text'],
    [/^02-background|^background[/]|^bg[/]/i, 'background'],
    [/^03-action|^action[/]|^button[/]|^cta[/]/i, 'action'],
    [/^04-icon|^icon[/]|^icons[/]/i, 'icon'],
    [/^05-surface|^surface[/]|^card[/]|^elevation[/]/i, 'surface'],
    [/^06-border|^border[/]|^stroke[/]|^outline[/]|^divider[/]/i, 'border'],
    [/^07-link|^link[/]/i, 'link'],
    [/^success|^warning|^error|^info|^status|^destructive/i, 'status'],
    [/^chip[/]|^badge[/]|^tag[/]|^pill[/]/i, 'chip'],
    [/^input[/]|^field[/]|^form[/]/i, 'input'],
    [/^nav[/]|^navigation[/]|^menu[/]/i, 'nav'],
    [/^overlay[/]|^scrim[/]|^modal[/]/i, 'overlay'],
    [/^misc|^route/i, 'misc'],
  ];

  for (const token of tokens) {
    const isPrimitive = (token.collectionName || '').toLowerCase().includes('primitive');
    if (isPrimitive) continue;
    
    allSemantic.push(token);
    
    const name = token.name.toLowerCase();
    let matched = false;
    for (const [pattern, category] of categoryPatterns) {
      if (pattern.test(name) || pattern.test((token.collectionName || '').toLowerCase())) {
        if (!categories.has(category)) categories.set(category, []);
        categories.get(category)!.push(token);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (!categories.has('general')) categories.set('general', []);
      categories.get('general')!.push(token);
    }
  }

  return { categories, allSemantic, allTokens: tokens };
}

// ── Pattern Learning ─────────────────────────────────────────────────────────
// Learns from already-bound variables in the file: "in buttons, blue fill → 03-action/primary"

export interface UsagePattern {
  tokenId: string;
  tokenName: string;
  contexts: string[];     // ['button', 'card', ...]
  nodeTypes: string[];    // ['FRAME', 'TEXT', ...]
  count: number;
}

// ── Context Detection (deep) ─────────────────────────────────────────────────

const COMPONENT_PATTERNS: Array<[RegExp, string]> = [
  [/button|btn\b|\bcta\b|primary.?button|secondary.?button|submit\b/i, 'button'],
  [/\bchip\b|\btag\b|\bbadge\b|\bpill\b|\bstatus.?pill/i, 'chip'],
  [/\binput\b|text.?field|search.?field|\bform\b|text.?input|text.?box|\bhelper\b|placeholder/i, 'input'],
  [/\bcard\b|\btile\b|list.?item|\bcell\b/i, 'card'],
  [/\bnav\b|navigation|sidebar|menu\b|navbar|\btab.?bar\b|bottom.?bar/i, 'nav'],
  [/\bmodal\b|\bdialog\b|\bpopup\b|\balert\b/i, 'modal'],
  [/\bsheet\b|\bdrawer\b|bottom.?sheet/i, 'sheet'],
  [/\btoast\b|snackbar|notification\b|\bannouncement/i, 'toast'],
  [/\bavatar\b|profile.?pic/i, 'avatar'],
  [/\btoggle\b|\bswitch\b|\bcheckbox\b|\bradio\b/i, 'toggle'],
  [/\btooltip\b|\bpopover\b|\bhint\b/i, 'tooltip'],
  [/\btab\b(?!le)|\btabs\b/i, 'tab'],
  [/\bstepper\b|\bprogress\b|\bslider\b/i, 'progress'],
  [/\bbanner\b|\bhero\b/i, 'banner'],
  [/\btable\b|\brow\b|\bcol\b|\bheader\b|\bdata.?grid/i, 'table'],
  [/\bdropdown\b|\bselect\b|\bpicker\b|\bcombobox/i, 'dropdown'],
];

const PROPERTY_KEYWORDS: Array<[RegExp, string]> = [
  [/overlay|scrim|backdrop|mask/i, 'overlay'],
  [/border|stroke|outline|divider|separator|hairline/i, 'border'],
  [/shadow|elevation|drop.?shadow/i, 'shadow'],
  [/placeholder|hint/i, 'placeholder'],
];

export function detectSemanticRole(
  nodeName: string,
  nodeType: string,
  parentName: string,
  ancestorName: string,
  propertyType: 'fill' | 'stroke'
): SemanticRole {
  const nL = nodeName.toLowerCase();
  const pL = parentName.toLowerCase();
  const aL = ancestorName.toLowerCase();
  const combined = nL + ' ' + pL + ' ' + aL;

  // ── Detect component ──
  let component = 'general';
  // Check ancestor first (most reliable — it's the component boundary)
  for (const [pattern, comp] of COMPONENT_PATTERNS) {
    if (pattern.test(aL)) { component = comp; break; }
  }
  // Then parent
  if (component === 'general') {
    for (const [pattern, comp] of COMPONENT_PATTERNS) {
      if (pattern.test(pL)) { component = comp; break; }
    }
  }

  // ── Detect category (what IS this color?) ──
  let category = 'general';

  // Node type is strongest signal
  if (['VECTOR', 'LINE', 'POLYGON', 'STAR', 'BOOLEAN_OPERATION', 'ELLIPSE'].includes(nodeType)) {
    // Vector inside specific components
    if (/icon|\bsvg\b|glyph|chevron|arrow|check|close|search|logo/i.test(nL))
      category = 'icon';
    else if (component === 'button' || component === 'nav')
      category = 'icon'; // vectors inside buttons are usually icons
    else
      category = 'icon';
  } else if (nodeType === 'TEXT') {
    category = 'text';
  } else if (propertyType === 'stroke') {
    category = 'border';
  } else {
    // Name-based detection for fills
    for (const [pattern, prop] of PROPERTY_KEYWORDS) {
      if (pattern.test(nL)) { category = prop === 'border' || prop === 'shadow' ? 'border' : prop; break; }
    }
    if (category === 'general') {
      if (/\bicon\b|\bsvg\b|glyph|chevron|\barrow\b|\bcheck\b|\bclose\b/i.test(nL))
        category = 'icon';
      else if (/success|error|warning|danger|destructive|\binfo\b/i.test(combined))
        category = 'status';
      else if (/background|bg\b|surface|fill\b|base\b|canvas/i.test(nL))
        category = 'background';
      else if (/overlay|scrim/i.test(nL))
        category = 'overlay';
    }
  }

  // ── Detect property type ──
  let property = propertyType === 'stroke' ? 'stroke' : 'fill';
  if (nodeType === 'TEXT') property = 'text-fill';
  if (/icon|\bsvg\b|vector/i.test(nL)) property = 'icon-fill';
  if (/placeholder|hint/i.test(nL)) property = 'placeholder';

  // ── Infer semantic role ──
  let inferredRole = category + '/' + (category === 'general' ? 'default' : 'primary');

  // Refine based on name keywords
  if (/secondary|sub|muted|subtle/i.test(nL)) inferredRole = category + '/secondary';
  if (/tertiary|dim/i.test(nL)) inferredRole = category + '/tertiary';
  if (/disabled|inactive/i.test(nL)) inferredRole = category + '/disabled';
  if (/inverse|inverted|on.?dark/i.test(nL)) inferredRole = category + '/inverse';
  if (/hover|hovered/i.test(nL)) inferredRole = category + '/hover';
  if (/pressed|active/i.test(nL)) inferredRole = category + '/pressed';
  if (/focus|focused/i.test(nL)) inferredRole = category + '/focus';
  if (/brand/i.test(nL)) inferredRole = category + '/brand';
  if (/success/i.test(combined)) inferredRole = 'status/success';
  if (/error|danger|destructive/i.test(combined)) inferredRole = 'status/error';
  if (/warning/i.test(combined)) inferredRole = 'status/warning';
  if (/\binfo\b/i.test(combined)) inferredRole = 'status/info';

  return { category, component, property, inferredRole };
}

// ── Multi-factor Matching ────────────────────────────────────────────────────
//
// COLOR FIRST, NAMES SECOND. The visual match is the gate AND the dominant
// score; semantic/context/name signals only re-rank tokens that are already
// visually plausible. A red stroke must never be matched to a grey token just
// because that grey token is named "border".
//
// Hard gates (candidate is dropped entirely):
//   1. ΔE > MAX_DELTA_E                      → not the same color, period.
//   2. Both colors chromatic + hue families  → e.g. red vs blue, red vs grey
//      differ (>48°), or one is chromatic and the other is achromatic.
//
// Scoring: confidence ≈ visual similarity (0–92) + semantic bonus (0–8).
// Among tokens with identical values, the semantic bonus decides the order —
// which is exactly where naming SHOULD matter.

const MAX_DELTA_E = 18;        // beyond this, colors read as "different"
const CHROMATIC_MIN = 14;      // LAB chroma above this = a "real" color, not grey
const ACHROMATIC_MAX = 8;      // LAB chroma below this = grey / near-grey
const MAX_HUE_DIFF = 48;       // degrees; larger = different hue family

function visualScoreFromDeltaE(de: number): number {
  if (de <= 0.25) return 100;
  if (de <= 1)  return 98;
  if (de <= 2)  return 95;
  if (de <= 3)  return 92;
  if (de <= 5)  return 86;
  if (de <= 8)  return 76;
  if (de <= 12) return 62;
  return 45; // 12 < de <= MAX_DELTA_E
}

function visualReason(de: number): string {
  if (de <= 0.25) return 'Exact same color';
  if (de <= 2)  return 'Nearly identical color';
  if (de <= 5)  return 'Very close color';
  if (de <= 10) return 'Close color';
  return 'Closest available color';
}

export function findSemanticMatches(
  rgb: RGBColor,
  role: SemanticRole,
  index: DesignSystemIndex,
  patterns: UsagePattern[],
  topN = 3
): MatchCandidate[] {
  // Prefer semantic tokens; fall back to the full set so files whose tokens
  // are all "primitives" still get suggestions.
  const pool = index.allSemantic.length > 0 ? index.allSemantic : index.allTokens;
  if (pool.length === 0) return [];

  const categoryPool = index.categories.get(role.category) || [];
  const target = chromaHue(rgb);
  const targetIsChromatic = target.chroma >= CHROMATIC_MIN;
  const targetIsGrey = target.chroma <= ACHROMATIC_MAX;

  const candidates: MatchCandidate[] = [];

  for (const token of pool) {
    // ── GATE 1: perceptual distance ──────────────────────────────────────
    const de = colorDistance(rgb, token.rgb);
    if (de > MAX_DELTA_E) continue;

    // ── GATE 2: hue family ───────────────────────────────────────────────
    const tok = chromaHue(token.rgb);
    if (targetIsChromatic && tok.chroma <= ACHROMATIC_MAX) continue;      // red → grey: never
    if (targetIsGrey && tok.chroma >= CHROMATIC_MIN) continue;            // grey → red: never
    if (targetIsChromatic && tok.chroma >= CHROMATIC_MIN &&
        hueDiff(target.hue, tok.hue) > MAX_HUE_DIFF) continue;            // red → blue: never

    const reasons: string[] = [visualReason(de)];
    const tokenNameL = token.name.toLowerCase();

    // ── Semantic bonus (0–8): only re-ranks visually plausible tokens ────
    let semanticBonus = 0;
    let semanticScore = 0;

    if (categoryPool.indexOf(token) !== -1) {
      semanticBonus += 4;
      semanticScore = 80;
      if (role.category !== 'general') reasons.push(`Named for ${role.category}s`);
    }

    const roleKeywords = role.inferredRole.split('/');
    for (const kw of roleKeywords) {
      if (kw.length > 2 && kw !== 'default' && kw !== 'general' && tokenNameL.includes(kw)) {
        semanticBonus += 2;
        semanticScore = Math.min(100, semanticScore + 20);
        break;
      }
    }

    // Component context (button/chip/input…) — small nudge only
    let contextScore = 0;
    const componentMap: Record<string, string[]> = {
      button: ['action', 'button', 'cta'],
      chip: ['chip', 'tag', 'badge', 'pill'],
      input: ['input', 'field', 'form', 'placeholder'],
      card: ['card', 'surface', 'container'],
      nav: ['nav', 'navigation', 'menu', 'link'],
      modal: ['modal', 'dialog', 'overlay'],
      toast: ['toast', 'notification', 'alert', 'snackbar'],
      tab: ['tab', 'navigation'],
    };
    const compKeywords = componentMap[role.component] || [];
    if (compKeywords.some(k => tokenNameL.includes(k))) {
      semanticBonus += 1;
      contextScore = 80;
      reasons.push(`Used in ${role.component}s`);
    }

    // ── Pattern bonus (0–2): how this file already uses this token ───────
    let patternScore = 0;
    const pattern = patterns.find(p => p.tokenId === token.variableId);
    if (pattern) {
      if (pattern.contexts.includes(role.component)) {
        semanticBonus += 2;
        patternScore = 90;
        reasons.push('Already used in ' + role.component + 's in this file');
      } else if (pattern.count >= 5) {
        semanticBonus += 1;
        patternScore = 50;
        reasons.push('Used ' + pattern.count + '× elsewhere in this file');
      }
    }

    // ── Hierarchy bonus (0–1): primary↔primary, disabled↔disabled ───────
    let hierarchyScore = 50;
    for (const level of ['primary', 'secondary', 'tertiary', 'disabled']) {
      if (role.inferredRole.includes(level) && tokenNameL.includes(level)) {
        semanticBonus += 1;
        hierarchyScore = 100;
        break;
      }
    }

    // ── Final confidence: visual dominates, semantics fine-tune ─────────
    const visualScore = visualScoreFromDeltaE(de);
    let confidence = Math.round(visualScore * 0.92 + Math.min(8, semanticBonus));
    if (de <= 0.25) confidence = Math.max(confidence, 97); // identical value = always safe
    confidence = Math.min(100, confidence);

    candidates.push({
      token,
      confidence,
      deltaE: Math.round(de * 10) / 10,
      reasons: reasons.slice(0, 2),
      scores: { semantic: semanticScore, context: contextScore, visual: visualScore, pattern: patternScore, hierarchy: hierarchyScore }
    });
  }

  // Visual similarity decides; semantic bonus breaks ties between equal colors.
  candidates.sort((a, b) =>
    b.confidence - a.confidence ||
    b.scores.visual - a.scores.visual ||
    b.scores.semantic - a.scores.semantic
  );

  return candidates.slice(0, topN);
}

