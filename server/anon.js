import { randomUUID } from "node:crypto";

const COOKIE_NAME = "anon_id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

// Anonymous identity: a random id, set as an httpOnly cookie on first use.
// This is groundwork for per-owner behaviour (erasing is a later change);
// for now it's only ever written to a stroke's owner_id.
export function getOrSetAnonId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const existing = cookies[COOKIE_NAME];
  if (existing) return existing;

  const id = randomUUID();
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${id}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`,
  );
  return id;
}
