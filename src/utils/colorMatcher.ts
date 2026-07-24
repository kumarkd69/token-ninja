export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

interface LabColor {
  L: number;
  a: number;
  b: number;
}

function rgbToLab(rgb: RGBColor): LabColor {
  const lin = (c: number): number =>
    c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;

  const lr = lin(rgb.r);
  const lg = lin(rgb.g);
  const lb = lin(rgb.b);

  const X = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  const Y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750) / 1.00000;
  const Z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;

  const f = (t: number): number =>
    t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 16 / 116;

  return {
    L: 116 * f(Y) - 16,
    a: 500 * (f(X) - f(Y)),
    b: 200 * (f(Y) - f(Z))
  };
}

function deltaE2000(c1: LabColor, c2: LabColor): number {
  const { L: L1, a: a1, b: b1 } = c1;
  const { L: L2, a: a2, b: b2 } = c2;

  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const normDeg = (deg: number): number => ((deg % 360) + 360) % 360;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab = (C1 + C2) / 2;
  const Cab7 = Math.pow(Cab, 7);
  const G = 0.5 * (1 - Math.sqrt(Cab7 / (Cab7 + Math.pow(25, 7))));

  const ap1 = a1 * (1 + G);
  const ap2 = a2 * (1 + G);
  const Cp1 = Math.sqrt(ap1 * ap1 + b1 * b1);
  const Cp2 = Math.sqrt(ap2 * ap2 + b2 * b2);

  const hp1 = normDeg((Math.atan2(b1, ap1) * 180) / Math.PI);
  const hp2 = normDeg((Math.atan2(b2, ap2) * 180) / Math.PI);

  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;

  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    const diff = hp2 - hp1;
    dhp =
      Math.abs(diff) <= 180
        ? diff
        : diff > 180
        ? diff - 360
        : diff + 360;
  }

  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(toRad(dhp / 2));
  const Lpm = (L1 + L2) / 2;
  const Cpm = (Cp1 + Cp2) / 2;

  let hpm = (hp1 + hp2) / 2;
  if (Cp1 * Cp2 !== 0 && Math.abs(hp1 - hp2) > 180) {
    hpm += hp1 + hp2 < 360 ? 180 : -180;
  }

  const T =
    1 -
    0.17 * Math.cos(toRad(hpm - 30)) +
    0.24 * Math.cos(toRad(2 * hpm)) +
    0.32 * Math.cos(toRad(3 * hpm + 6)) -
    0.2 * Math.cos(toRad(4 * hpm - 63));

  const SL =
    1 +
    (0.015 * Math.pow(Lpm - 50, 2)) / Math.sqrt(20 + Math.pow(Lpm - 50, 2));
  const SC = 1 + 0.045 * Cpm;
  const SH = 1 + 0.015 * Cpm * T;

  const Cpm7 = Math.pow(Cpm, 7);
  const RC = 2 * Math.sqrt(Cpm7 / (Cpm7 + Math.pow(25, 7)));
  const dTheta = 30 * Math.exp(-Math.pow((hpm - 275) / 25, 2));
  const RT = -Math.sin(toRad(2 * dTheta)) * RC;

  return Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH)
  );
}

// Perceptual distance between two RGB colors (CIEDE2000)
export function colorDistance(a: RGBColor, b: RGBColor): number {
  return deltaE2000(rgbToLab(a), rgbToLab(b));
}

// Chroma (colorfulness) and hue angle in LAB space — used to keep suggestions
// inside the same hue family (a red must never be matched to a grey).
export interface ChromaHue { chroma: number; hue: number; lightness: number; }

export function chromaHue(rgb: RGBColor): ChromaHue {
  const lab = rgbToLab(rgb);
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { chroma, hue, lightness: lab.L };
}

export function hueDiff(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

export interface ColorToken {
  name: string;
  variableId: string;
  rgb: RGBColor;
  collectionName?: string;
}

export interface TokenMatch {
  tokenName: string;
  tokenValue: string;
  variableId: string;
  distance: number;
  isVariable: boolean;
}

export function rgbToHex(rgb: RGBColor): string {
  const toHex = (v: number): string =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
}

export function findClosestColorToken(
  target: RGBColor,
  tokens: ColorToken[]
): TokenMatch | null {
  if (tokens.length === 0) return null;

  const targetLab = rgbToLab(target);
  let bestDistance = Infinity;
  let bestToken = tokens[0];

  for (const token of tokens) {
    const d = deltaE2000(targetLab, rgbToLab(token.rgb));
    if (d < bestDistance) {
      bestDistance = d;
      bestToken = token;
    }
  }

  return {
    tokenName: bestToken.name,
    tokenValue: rgbToHex(bestToken.rgb),
    variableId: bestToken.variableId,
    distance: parseFloat(bestDistance.toFixed(2)),
    isVariable: !bestToken.variableId.startsWith('S:')
  };
}