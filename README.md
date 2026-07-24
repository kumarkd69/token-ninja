# 🥷 Token Ninja

**Every color and text mapped to your design tokens — automatically.**

Token Ninja scans any Figma frame for *orphan* values — colors not bound to a
variable, text not using a style — and intelligently maps each one to the
closest matching token in your design system. Review, preview, apply.

Built by [Kumar Ballari](https://www.linkedin.com/in/kumarballari/) ·
[☕ Buy me a coffee](https://buymeacoffee.com/kumarballari)

## Features

- **Perceptual color matching** — CIEDE2000 (ΔE) in LAB space, not RGB math.
  Hard hue-family gates mean a red can never be matched to a grey, no matter
  what the tokens are named.
- **Size-first typography matching** — a loose `14/Semibold` snaps to the
  nearest 14px style with the closest weight (heavier wins ties). Styles more
  than 4px away are never suggested.
- **Learns your file** — layers already bound to variables teach the matcher
  which token belongs in which component context.
- **Learns from you** — pick a token manually once and Token Ninja suggests it
  first for that color forever.
- **Hover preview** — see any suggestion live on canvas before applying.
- **Auto-scan** — optional: scans automatically when you select a frame.
- **Rescan** — re-checks the same frame mid-cleanup, even if deselected.
- **Health report** — token coverage %, pending/fixed counts; export as
  Markdown or CSV for your team.
- **Safe by default** — nothing is applied without review; bulk-apply only
  touches ≥95% confidence matches; everything is one undo step.

## Development

```bash
npm install
npm run build       # production build → dist/code.js
npm run watch       # rebuild on change
```

Then in Figma desktop: **Plugins → Development → Import plugin from manifest…**
and select `manifest.json`.

## Architecture

```
src/
  code.ts                 Plugin sandbox: scan orchestration, apply engine,
                          auto-scan, hover preview, learned picks (clientStorage)
  ui.html                 Single-file UI (inlined by webpack asset/source)
  utils/
    nodeTraverser.ts      Recursive scan: orphan fills/strokes/texts + bound-usage
                          collection for pattern learning
    tokenExtractor.ts     Variables + paint styles + text styles loaders,
                          alias resolution, size-first text matching
    colorMatcher.ts       sRGB→LAB, CIEDE2000, chroma/hue helpers
    semanticEngine.ts     Design-system index, role detection, color-first
                          multi-factor matching
```

### How color matching works

1. Convert both colors sRGB → linear → XYZ → **CIELAB**.
2. Distance = **CIEDE2000 (ΔE)** — the perceptual gold standard.
3. **Hard gates:** candidates with ΔE > 18, a different hue family (>48°), or a
   chromatic↔achromatic mismatch are dropped entirely.
4. Confidence ≈ visual similarity (92%) + semantic bonus (8%): category names,
   component context, file usage patterns, and hierarchy only re-rank tokens
   that are already visually plausible.
5. No survivor → honest **"no match"**, flagged for manual pick.

## Roadmap

- Effect tokens (shadows, blurs) · radius & spacing variables
- Create-token-from-orphan for gap colors
- Team-shared learning via `setSharedPluginData`
- Mode-aware matching (light/dark)

## License

[MIT](LICENSE)
