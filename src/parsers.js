// Card data parsers
//
// Each parser: (raw: string) => string | null
//   Returns the extracted card identifier on match, or null to pass through.
//
// Card formats:
//   Full:   "1570=900000001=00=6017700001111110"  -> "000111111"
//           Equals-delimited, extract 601770* segment, strip 9-char prefix,
//           drop check digit (last char), zero-pad to 9 digits.
//
//   Mobile: "6017700010001111"                    -> "6017700010001111"
//           16-digit number starting with 601770, returned as-is.
//
//   Short:  "111111"                              -> "000111111"
//           Plain numeric, zero-padded to 9 digits.

const CARD_ID_LENGTH = 9;

/**
 * Full format parser.
 *
 * Matches equals-delimited scan data (e.g. "1570=903976305=00=6017700007889970").
 * Finds the segment starting with "601770", strips the 9-char prefix,
 * drops the trailing check digit, and zero-pads to 9 digits.
 */
function fullParser(raw) {
  if (!raw.includes("=")) return null;

  const segments = raw.split("=");
  const seg = segments.find((s) => s.startsWith("601770"));
  if (!seg) return null;

  const body = seg.slice(9, -1);
  if (!body || !/^\d+$/.test(body)) return null;

  return body.padStart(CARD_ID_LENGTH, "0");
}

/**
 * Mobile format parser.
 *
 * Matches a 16-digit number starting with "601770" (full mobile credential).
 * Returned as-is.
 */
function mobileParser(raw) {
  if (/^601770\d{10}$/.test(raw)) return raw;
  return null;
}

/**
 * Short format parser.
 *
 * Matches a plain numeric string (up to 9 digits) and zero-pads to 9 digits.
 */
function shortParser(raw) {
  if (/^\d+$/.test(raw) && raw.length <= CARD_ID_LENGTH) {
    return raw.padStart(CARD_ID_LENGTH, "0");
  }
  return null;
}

const builtinParsers = [fullParser, mobileParser, shortParser];

function createCardParser(parsers) {
  return function parseCardData(raw) {
    for (const parser of parsers) {
      const result = parser(raw);
      if (result !== null) return result;
    }
    return null;
  };
}

module.exports = { builtinParsers, createCardParser };
