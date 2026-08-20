/**
 * Standardized Tether (USDT) mark as an inline SVG string.
 *
 * Based on the Tether brand mark: green circular field with a white/light
 * "T" and a horizontal ring. The SVG is optimized for very small sizes
 * (~16–20px) and contains no metadata or raster data.
 *
 * @param {Object} [options]
 * @param {string} [options.className='h-4 w-4'] - Tailwind sizing/classes
 * @returns {string} SVG markup
 */
export function TetherIcon({ className = 'h-4 w-4' } = {}) {
  return `<svg class="${className} flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="12" fill="#26A17B"/>
    <ellipse cx="12" cy="12" rx="8.5" ry="2.7" fill="none" stroke="#F5F5F7" stroke-width="1.5"/>
    <path d="M8 5h8v2.75h-2.625v11.5h-2.75V7.75H8V5z" fill="#F5F5F7"/>
  </svg>`;
}
