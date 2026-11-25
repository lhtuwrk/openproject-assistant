// claude-icon.js — the Claude spark, in Claude's orange (--claude): eleven petals, thin where they
// meet the centre and widening to a rounded tip, at uneven angles and lengths so it reads hand-cut
// rather than a gear. Shared by every surface that shows the Claude mark (Planning's Claude strip,
// the floating assistant).

export const CLAUDE_ICON = (() => {
  const RAYS = [   // [angle° clockwise from top, length, tip width]
    [0, 10.6, 2.9], [33, 8.3, 2.5], [63, 9.9, 2.8], [96, 7.6, 2.4], [127, 10.3, 2.9], [160, 8.7, 2.6],
    [191, 10.0, 2.8], [222, 7.7, 2.4], [253, 10.5, 2.9], [287, 8.1, 2.5], [318, 9.5, 2.7],
  ];
  const R0 = 1.0, W0 = 0.75, f = n => +n.toFixed(2);
  const petal = ([deg, len, w]) => {
    const a = (deg - 90) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const P = (x, y) => `${f(x * c - y * s)} ${f(x * s + y * c)}`;   // a petal drawn along +x, then turned
    const r = w / 2, tip = len - r;
    return `M${P(R0, -W0 / 2)}L${P(tip, -r)}A${f(r)} ${f(r)} 0 0 1 ${P(tip, r)}L${P(R0, W0 / 2)}Z`;
  };
  const d = RAYS.map(petal).join('') + 'M-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0Z';
  return `<svg class="claude-icon" viewBox="-12 -12 24 24" aria-hidden="true" focusable="false"><path d="${d}" /></svg>`;
})();
