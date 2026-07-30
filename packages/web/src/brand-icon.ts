import type { Accent, SystemConfig } from '@gian/shared';

export const GIAN_ICON_VIEWBOX = 1254;

export const GIAN_VOICE_BODY_PATH = 'M 325.499 225.250 C 329.028 247.468, 341.226 276.934, 354.769 295.954 C 367.028 313.171, 388.739 334.063, 404.709 344.010 C 408.674 346.479, 411.906 348.725, 411.892 349 C 411.877 349.275, 406.466 354, 399.867 359.500 C 369.450 384.850, 340.500 418.634, 320.602 452 C 279.712 520.568, 262.617 600.138, 271.618 680 C 285.636 804.389, 362.679 911.766, 477.504 966.952 C 556.149 1004.750, 640.191 1014.162, 719.702 994.077 C 800.915 973.562, 870.472 922.786, 920.493 847.500 C 962.251 784.651, 983.945 714.695, 983.990 642.750 L 984 626 L 815 626 C 722.050 626, 646 626.381, 646 626.848 C 646 627.314, 652.792 637.326, 661.093 649.098 C 669.394 660.869, 685.694 684.337, 697.316 701.250 L 718.446 732 L 725.950 732 L 733.453 732 725.477 740.046 C 690.502 775.323, 634.367 787.766, 586.312 770.893 C 545.909 756.707, 512.586 722.928, 499.112 682.500 C 486.436 644.464, 490.870 608.746, 512.310 576.190 C 535.523 540.944, 573.204 517.021, 613.498 511.949 C 625.493 510.439, 647.396 511.185, 658.334 513.475 C 689.158 519.930, 718.909 538.889, 737.849 564.146 L 742.084 569.792 751.792 564.522 C 778.626 549.956, 832.551 521.153, 866 503.520 C 927.400 471.154, 934 467.570, 934 466.600 C 934 466.090, 930.076 459.142, 925.279 451.161 C 889.653 391.877, 837.262 343.273, 775.878 312.558 C 747.030 298.123, 720.436 288.964, 687.328 282.059 C 659.075 276.168, 655.115 275.874, 592 275 C 532.115 274.170, 517.485 273.350, 483.500 268.917 C 431.097 262.082, 382.468 248.242, 341.101 228.390 C 332.632 224.325, 325.505 221, 325.263 221 C 325.022 221, 325.128 222.912, 325.499 225.250';

export const GIAN_VOICE_LINE_TOP_PATH = 'M 966.169 331.983 C 964.337 332.421, 961.490 334.067, 959.842 335.640 C 952.703 342.453, 917.467 380.185, 916.326 382.239 C 914.387 385.732, 914.723 393.033, 916.995 396.759 C 920.974 403.286, 930.266 406.016, 936.800 402.580 C 938.285 401.798, 949.487 390.797, 961.694 378.133 C 985.276 353.666, 987.006 351.175, 985.603 343.698 C 984.033 335.328, 974.982 329.872, 966.169 331.983';

export const GIAN_VOICE_LINE_BOTTOM_PATH = 'M 985.028 407.574 C 968.818 415.026, 954.948 421.628, 954.205 422.245 C 948.994 426.569, 947.684 437.349, 951.699 442.864 C 954.634 446.897, 961.786 450.217, 965.921 449.466 C 968.967 448.913, 1004.404 433.504, 1022.283 424.958 C 1030.674 420.947, 1033.262 417.598, 1033.788 410.065 C 1034.252 403.427, 1031.607 398.579, 1025.980 395.752 C 1019.160 392.325, 1016.573 393.072, 985.028 407.574';

const ACCENTS: Record<Accent, { hue: number; chroma: number }> = {
  rose: { hue: 5, chroma: 0.15 },
  ember: { hue: 35, chroma: 0.14 },
  citron: { hue: 95, chroma: 0.13 },
  moss: { hue: 150, chroma: 0.11 },
  teal: { hue: 195, chroma: 0.11 },
  azure: { hue: 230, chroma: 0.13 },
  ink: { hue: 270, chroma: 0.13 },
  plum: { hue: 320, chroma: 0.14 },
};

const THEME_LIGHTNESS: Record<SystemConfig['theme'], [number, number, number]> = {
  light: [0.66, 0.74, 0.58],
  warm: [0.64, 0.73, 0.56],
  dark: [0.70, 0.80, 0.62],
};

export function gianIconGradient(
  theme: SystemConfig['theme'],
  accent: Accent,
): [string, string, string] {
  const [l1, l2, l3] = THEME_LIGHTNESS[theme];
  const { hue, chroma } = ACCENTS[accent];
  const outerChroma = (chroma + 0.04).toFixed(2);
  const centerChroma = (chroma + 0.06).toFixed(2);
  return [
    `oklch(${l1} ${outerChroma} ${hue - 46})`,
    `oklch(${l2} ${centerChroma} ${hue + 8})`,
    `oklch(${l3} ${outerChroma} ${hue + 60})`,
  ];
}

export function buildGianIconSvg(
  theme: SystemConfig['theme'],
  accent: Accent,
): string {
  const [g1, g2, g3] = gianIconGradient(theme, accent);
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254">',
    '<defs><linearGradient id="accent" x1="0%" y1="26.65%" x2="100%" y2="73.35%">',
    `<stop offset="0%" stop-color="${g1}"/>`,
    `<stop offset="42%" stop-color="${g2}"/>`,
    `<stop offset="78%" stop-color="${g3}"/>`,
    `<stop offset="100%" stop-color="${g1}"/>`,
    '</linearGradient></defs>',
    '<rect width="1254" height="1254" rx="276" fill="url(#accent)"/>',
    `<path d="${GIAN_VOICE_BODY_PATH}" fill="#101111" fill-rule="evenodd"/>`,
    `<path d="${GIAN_VOICE_LINE_TOP_PATH}" fill="#101111"/>`,
    `<path d="${GIAN_VOICE_LINE_BOTTOM_PATH}" fill="#101111"/>`,
    '</svg>',
  ].join('');
}

interface GianDesktopBridge {
  setDockIcon?: (dataUrl: string) => Promise<boolean>;
}

function desktopBridge(): GianDesktopBridge | undefined {
  return (window as Window & { gianDesktop?: GianDesktopBridge }).gianDesktop;
}

function updateFavicon(svg: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.type = 'image/svg+xml';
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function renderDockIcon(
  theme: SystemConfig['theme'],
  accent: Accent,
): string | null {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const [g1, g2, g3] = gianIconGradient(theme, accent);
  const gradient = context.createLinearGradient(0, size * 0.2665, size, size * 0.7335);
  gradient.addColorStop(0, g1);
  gradient.addColorStop(0.42, g2);
  gradient.addColorStop(0.78, g3);
  gradient.addColorStop(1, g1);

  context.beginPath();
  context.roundRect(0, 0, size, size, size * 0.22);
  context.fillStyle = gradient;
  context.fill();

  context.save();
  context.scale(size / GIAN_ICON_VIEWBOX, size / GIAN_ICON_VIEWBOX);
  context.fillStyle = '#101111';
  context.fill(new Path2D(GIAN_VOICE_BODY_PATH), 'evenodd');
  context.fill(new Path2D(GIAN_VOICE_LINE_TOP_PATH));
  context.fill(new Path2D(GIAN_VOICE_LINE_BOTTOM_PATH));
  context.restore();

  return canvas.toDataURL('image/png');
}

export function applyGianIconAppearance(
  theme: SystemConfig['theme'],
  accent: Accent,
): void {
  updateFavicon(buildGianIconSvg(theme, accent));

  const bridge = desktopBridge();
  if (!bridge?.setDockIcon) return;

  try {
    const icon = renderDockIcon(theme, accent);
    if (icon) void bridge.setDockIcon(icon);
  } catch {
    // The favicon still updates when a browser lacks Canvas OKLCH support.
  }
}
