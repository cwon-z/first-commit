/* ============================================================================
 * first-commit — icons
 * ----------------------------------------------------------------------------
 * The seven marks the interface needs, as inline SVG. No icon font, no sprite
 * sheet, no network request — a handful of stroked paths on a 24-unit grid,
 * sized in `em` so an icon always matches the text it sits beside.
 *
 * Every icon is aria-hidden: an icon in this UI always accompanies a label or
 * an aria-label, never carries meaning alone.
 * ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** name → [path commands…]. Stroked, never filled, so weight stays even. */
const PATHS = {
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  play: ['M8 5.5v13l11-6.5z'],
  files: ['M9 3.5h5l4.5 4.5V17H9z', 'M14 3.5V8h4.5', 'M5.5 8v12.5H16'],
  lightbulb: ['M12 3.5a5 5 0 0 0-3 9v2h6v-2a5 5 0 0 0-3-9z', 'M10.5 19h3'],
  'arrow-right': ['M5 12h13', 'M12.5 6.5 19 12l-6.5 5.5'],
  check: ['M5 12.5 9.5 17 19 7.5'],
  reset: ['M4.5 11a7.5 7.5 0 1 1 1.9 5.6', 'M4 5.5V11h5.5'],
  user: ['M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  chart: ['M4 20h16', 'M7 20v-7', 'M12 20V6', 'M17 20v-4'],
};

/**
 * @param {keyof PATHS} name
 * @param {{ size?: string }} [opts] CSS length; defaults to 1em so it tracks type
 * @returns {SVGElement}
 */
export function icon(name, opts = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon icon-' + name);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', opts.size || '1em');
  svg.setAttribute('height', opts.size || '1em');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

/** Convenience: a button's icon plus its label, in one call. */
export function iconLabel(button, name, label) {
  button.append(icon(name), label);
  return button;
}

export default icon;
