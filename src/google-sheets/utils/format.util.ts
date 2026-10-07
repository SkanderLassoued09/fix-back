import { withErrorContext, reportCatchError } from '../../common/error-context';
/**
 * Format any Date-coercible value to "YYYY-MM-DD HH:mm" (the spec).
 * Returns the empty string if the input is null/undefined, returns 'N/A'
 * if it's defined but unparseable — keeps the mapper code one-liner short.
 */
export function formatDateForSheet(value: any): string {
  try {
    if (value === null || value === undefined || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return 'N/A';

    const pad = (n: number) => String(n).padStart(2, '0');
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  } catch (error) {
    throw withErrorContext(error, 'formatDateForSheet');
  }
}

/**
 * Safe cell value coercion. Used everywhere a DB field might be null/missing.
 *
 *   null / undefined / "" → ""        (per spec rule #2: field missing)
 *   non-coercible value   → "N/A"     (per spec rule #3: field invalid)
 *   anything else         → String(v)
 */
export function safeCell(value: any): string {
  try {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && !isNaN(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
    try {
      const s = String(value);
      return s.startsWith('[object') ? 'N/A' : s;
    } catch (caughtError) {
      reportCatchError(caughtError, 'safeCell');
      return 'N/A';
    }
  } catch (error) {
    throw withErrorContext(error, 'safeCell');
  }
}

/** Coalesce — returns the first non-empty value, else empty string. */
export function firstNonEmpty(...values: any[]): string {
  try {
    for (const v of values) {
      const s = safeCell(v);
      if (s) return s;
    }
    return '';
  } catch (error) {
    throw withErrorContext(error, 'firstNonEmpty');
  }
}
