// nodeTraverser.ts — tracks full component hierarchy for smart context detection
export interface OrphanColor {
  nodeId: string; nodeName: string; nodeType: string;
  parentName: string;
  ancestorName: string; // nearest FRAME/COMPONENT/INSTANCE ancestor — key for component context
  propertyType: 'fill' | 'stroke';
  r: number; g: number; b: number; opacity: number; fillIndex: number;
}
export interface OrphanText {
  nodeId: string; nodeName: string;
  parentName: string; ancestorName: string;
  fontFamily: string; fontStyle: string; fontSize: number;
}
export interface TraversalStats { totalColorFills: number; totalTextNodes: number; }

// Layers that are ALREADY bound to a variable — the file's own conventions,
// which the matcher learns from ("in this file, buttons use action/primary").
export interface BoundUsage {
  variableId: string; nodeName: string; nodeType: string;
  parentName: string; ancestorName: string;
  propertyType: 'fill' | 'stroke';
}
const MAX_BOUND_USAGES = 3000; // perf cap on huge files

function isFillBound(node: SceneNode, field: 'fills'|'strokes', index: number): boolean {
  return boundVarId(node, field, index) != null;
}

function boundVarId(node: SceneNode, field: 'fills'|'strokes', index: number): string | null {
  const bv = (node as unknown as Record<string,unknown>).boundVariables as Record<string,unknown>|undefined;
  if (!bv) return null;
  const fb = bv[field];
  if (!fb || typeof fb !== 'object') return null;
  const entry = (fb as Record<string,unknown>)[String(index)] as { id?: string } | undefined;
  return entry && typeof entry.id === 'string' ? entry.id : null;
}

export function traverseForOrphans(
  node: SceneNode,
  orphanColors: OrphanColor[],
  orphanTexts: OrphanText[],
  stats: TraversalStats,
  boundUsages?: BoundUsage[],
  parentName = '',
  ancestorName = ''   // nearest meaningful component/frame ancestor
): void {
  if (!node.visible) return;

  if ('fills' in node) {
    const fills = node.fills;
    if (fills !== figma.mixed && Array.isArray(fills)) {
      (fills as Paint[]).forEach((paint, index) => {
        if (paint.type !== 'SOLID') return;
        const solid = paint as SolidPaint;
        const styleBound = typeof (node as unknown as Record<string,unknown>).fillStyleId === 'string' &&
          ((node as unknown as Record<string,unknown>).fillStyleId as string).length > 0;
        stats.totalColorFills++;
        const varId = boundVarId(node, 'fills', index);
        if (varId == null && !styleBound) {
          orphanColors.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type,
            parentName, ancestorName, propertyType: 'fill',
            r: solid.color.r, g: solid.color.g, b: solid.color.b,
            opacity: solid.opacity ?? 1, fillIndex: index });
        } else if (varId != null && boundUsages && boundUsages.length < MAX_BOUND_USAGES) {
          boundUsages.push({ variableId: varId, nodeName: node.name, nodeType: node.type,
            parentName, ancestorName, propertyType: 'fill' });
        }
      });
    }
  }

  if ('strokes' in node) {
    const strokes = (node as unknown as { strokes: Paint[] }).strokes;
    if (Array.isArray(strokes)) {
      strokes.forEach((paint, index) => {
        if (paint.type !== 'SOLID') return;
        const solid = paint as SolidPaint;
        const styleBound = typeof (node as unknown as Record<string,unknown>).strokeStyleId === 'string' &&
          ((node as unknown as Record<string,unknown>).strokeStyleId as string).length > 0;
        stats.totalColorFills++;
        const varId = boundVarId(node, 'strokes', index);
        if (varId == null && !styleBound) {
          orphanColors.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type,
            parentName, ancestorName, propertyType: 'stroke',
            r: solid.color.r, g: solid.color.g, b: solid.color.b,
            opacity: solid.opacity ?? 1, fillIndex: index });
        } else if (varId != null && boundUsages && boundUsages.length < MAX_BOUND_USAGES) {
          boundUsages.push({ variableId: varId, nodeName: node.name, nodeType: node.type,
            parentName, ancestorName, propertyType: 'stroke' });
        }
      });
    }
  }

  if (node.type === 'TEXT') {
    const t = node as TextNode;
    const hasStyle = typeof t.textStyleId === 'string' && t.textStyleId.length > 0;
    stats.totalTextNodes++;
    if (!hasStyle && t.fontName !== figma.mixed) {
      orphanTexts.push({ nodeId: node.id, nodeName: node.name, parentName, ancestorName,
        fontFamily: (t.fontName as FontName).family, fontStyle: (t.fontName as FontName).style,
        fontSize: t.fontSize !== figma.mixed ? (t.fontSize as number) : 0 });
    }
  }

  if ('children' in node) {
    // A FRAME/COMPONENT/INSTANCE with a meaningful name becomes the new ancestor
    const isContainer = ['FRAME','COMPONENT','COMPONENT_SET','INSTANCE'].includes(node.type);
    const nextAncestor = isContainer ? node.name : ancestorName;
    for (const child of (node as ChildrenMixin).children)
      traverseForOrphans(child as SceneNode, orphanColors, orphanTexts, stats, boundUsages, node.name, nextAncestor);
  }
}
