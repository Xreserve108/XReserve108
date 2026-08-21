/**
 * Compact Indian Rupee (INR) mark as an inline SVG string.
 *
 * A rounded-square badge with the ₹ glyph, styled to work in both
 * light and dark themes via Tailwind utility classes.
 *
 * @param {Object} [options]
 * @param {string} [options.className='h-5 w-5'] - Tailwind sizing/classes
 * @returns {string} SVG markup
 */
export function InrIcon({ className = 'h-5 w-5' } = {}) {
  return `<svg class="${className} flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="24" height="24" rx="7" fill="#F59E0B" fill-opacity="0.12"/>
    <text x="12" y="17" text-anchor="middle" font-size="14" font-weight="600" fill="#D97706" font-family="system-ui, sans-serif">₹</text>
  </svg>`;
}
