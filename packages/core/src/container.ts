// ISO 6346 container numbers: 3-letter owner code, a category letter
// (U freight, J detachable equipment, Z trailer/chassis), 6 digits and a
// check digit, e.g. MSCU1234565. A typo in one character almost always
// breaks the check digit, so a mistyped number is caught at entry instead
// of at the terminal gate.

const LETTER_VALUES: Record<string, number> = (() => {
  const values: Record<string, number> = {};
  let v = 10;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++; // 11, 22 and 33 are skipped
    values[ch] = v++;
  }
  return values;
})();

/** Upper-case and strip spaces, dashes and dots: "mscu 123456-5" → "MSCU1234565". */
export function normalizeContainerNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.\-/]/g, "");
}

export function containerCheckDigit(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10;
}

/** Why a container number is invalid, or null when it is a valid ISO 6346 number. */
export function containerNumberProblem(raw: string): string | null {
  const n = normalizeContainerNumber(raw);
  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(n)) return `${raw} is not a container number (4 letters ending in U, J or Z, then 7 digits)`;
  const expected = containerCheckDigit(n.slice(0, 10));
  if (Number(n[10]) !== expected) return `${n} fails the ISO 6346 check digit (expected ${expected}); check for a typo`;
  return null;
}
