// ============================================================
// INKTRACK API — validate.js
// Defensive input validation. Every value coming from the
// client is untrusted until it passes through here.
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LEN = 200;

const TATTOO_STYLES = [
  "Traditional", "Neo-Traditional", "Realism", "Fine Line",
  "Blackwork", "Japanese", "Tribal", "Watercolor"
];

export function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function ok(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function cleanText(value, maxLen = MAX_TEXT_LEN) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

export function isValidEmail(email) {
  return typeof email === "string" && email.length <= 254 && EMAIL_RE.test(email);
}

export function isValidPassword(password) {
  return typeof password === "string" && password.length >= 8 && password.length <= 256;
}

export function isValidDate(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) return false;
  const d = new Date(dateStr + "T00:00:00Z");
  return !isNaN(d.getTime());
}

export function isValidMoney(value) {
  return typeof value === "number" && isFinite(value) && value >= 0 && value < 1_000_000;
}

export function isValidHours(value) {
  return typeof value === "number" && isFinite(value) && value > 0 && value <= 24;
}

export function isValidStyle(style) {
  return style === null || style === undefined || TATTOO_STYLES.includes(style);
}

export { TATTOO_STYLES };