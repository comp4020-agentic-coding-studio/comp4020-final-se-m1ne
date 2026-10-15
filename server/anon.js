import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const COOKIE_NAME = "anon_id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

// Signing secret: ANON_COOKIE_SECRET if set (e.g. `fly secrets set`), otherwise
// generated once and kept beside the database on the persistent volume, so it
// is stable across restarts and deploys and is never committed to Git.
function loadSecret() {
  const fromEnv = process.env.ANON_COOKIE_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const dir = dirname(process.env.DB_PATH ?? "/data/app.db");
  const file = join(dir, "anon-cookie-secret");
  mkdirSync(dir, { recursive: true });
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    // first start: create it
  }
  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(file, secret, { mode: 0o600, flag: "wx" });
    return secret;
  } catch {
    return readFileSync(file, "utf8").trim(); // lost a creation race
  }
}

const SECRET = loadSecret();

function sign(id) {
  return createHmac("sha256", SECRET).update(id).digest("base64url");
}

// Returns the guest id only if the cookie value is `<id>.<valid signature>`.
function verify(value) {
  if (typeof value !== "string") return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null; // legacy unsigned ids land here
  const id = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // malformed escape: treat the cookie as absent
    }
  }
  return cookies;
}

// The verified guest id from the request's cookie, or null (absent, tampered,
// or legacy unsigned). Never sets anything.
export function readAnonId(req) {
  return verify(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

// Anonymous identity: a random id, set as a signed httpOnly cookie on first
// use. A cookie that does not verify is never accepted as an existing guest --
// it gets a fresh identity instead.
export function getOrSetAnonId(req, res) {
  const existing = readAnonId(req);
  if (existing) return existing;

  const id = randomUUID();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${id}.${sign(id)}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return id;
}
