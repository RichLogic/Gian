# Gian accent-aware icon brief

## Identity architecture

The application icon has two independent layers:

1. A stable primary logo mark provides recognition.
2. A full-background gradient is derived from the user's active Gian accent.

The mark does not need to be the current `G`, but it must work as a simple
near-black or white silhouette. The gradient supplies color, AI character,
and personalization; the logo should not compete with it by adding more
colors.

## Exact gradient source

The icon reuses the existing status-icon `g1/g2/g3` color calculations rather
than introducing a new brand palette. Its interpolation is icon-specific and
travels only once from `g1` to `g3`; project status/loading gradients retain
their existing final return to `g1`:

```css
--g1: oklch(var(--gL1) calc(var(--accent-c) + 0.04) calc(var(--accent-h) - 46));
--g2: oklch(var(--gL2) calc(var(--accent-c) + 0.06) calc(var(--accent-h) + 8));
--g3: oklch(var(--gL3) calc(var(--accent-c) + 0.04) calc(var(--accent-h) + 60));

background:
  linear-gradient(115deg, var(--g1), var(--g2) 42%, var(--g3));
```

Accent hue/chroma pairs:

| Accent | Hue | Chroma |
| --- | ---: | ---: |
| rose | 5 | 0.15 |
| ember | 35 | 0.14 |
| citron | 95 | 0.13 |
| moss | 150 | 0.11 |
| teal | 195 | 0.11 |
| azure | 230 | 0.13 |
| ink | 270 | 0.13 |
| plum | 320 | 0.14 |

Theme lightness bands remain the existing values:

- light: `0.66 / 0.74 / 0.58`
- warm: `0.64 / 0.73 / 0.56`
- dark: `0.70 / 0.80 / 0.62`

## Platform sizing

- Web favicon artwork fills its canvas for small-size legibility.
- macOS Dock and `.icns` canvases center the same tile at 84% scale, leaving
  8% transparent inset on every side. This matches the optical footprint of
  local Chrome (85.2%) and VS Code (83.6%) icons instead of filling 100% of
  the macOS canvas.

## Exploration rule

- Every concept must be shown with a gradient background.
- The primary mark is eye-free. Do not add eyes, a mouth, or any other facial
  expression.
- Singing and baseball are valid Gian character cues. They should be reduced
  into logo geometry rather than illustrated as detailed scenes.
- The selected direction is `Dragon G`: the original heavy charging `G`
  remains the coiled body, its pointed upper contour reads as a horn, and the
  two detached strokes read as whiskers. Keep the head unmarked. Later hair,
  stripe, eye, and geometric baseball refinements were rejected and must not
  replace it.
- The same mark must later survive all eight accent gradients and a
  monochrome menu-bar reduction.
- Generated images are direction studies, not production masters. A selected
  mark must be redrawn as controlled vector geometry before shipping.
