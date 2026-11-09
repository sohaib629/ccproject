// Tiny API client. Every call goes to the relative path /api/... so the same
// build works behind Vite (dev), nginx (Docker Compose) and the Gateway (cloud).

const TOKEN_KEY = "stocksync.token";
const USER_KEY = "stocksync.user";

// sessionStorage: the login ends when the browser tab closes. (Tradeoff: any
// script on the page could read it; an httpOnly cookie would be safer against
// XSS but needs CSRF protection. Acceptable for this project, noted in README.)
export const session = {
  get token() {
    return sessionStorage.getItem(TOKEN_KEY);
  },
  get user() {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  save(token, user) {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear() {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Call the API. Returns the parsed JSON body.
 * With { meta: true } returns { data, instance } where instance is the
 * X-Instance header: which API replica answered.
 */
export async function api(path, { method = "GET", body, meta = false } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (session.token) headers.authorization = `Bearer ${session.token}`;

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the server. Check your connection.");
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    // Expired or invalid token: log out everywhere in the app.
    if (res.status === 401 && session.token && path !== "/auth/login") {
      session.clear();
      window.dispatchEvent(new Event("stocksync:logout"));
    }
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "HTTP_" + res.status, err.message ?? res.statusText, err.details);
  }

  return meta ? { data, instance: res.headers.get("x-instance") } : data;
}

/** A readable message for any error, including per-field validation errors. */
export function errorMessage(err) {
  if (err?.details?.fields?.length) {
    return err.details.fields.map((f) => `${f.field}: ${f.message}`).join("; ");
  }
  return err?.message ?? "Something went wrong";
}

export const money = (cents) =>
  (cents / 100).toLocaleString("en-CA", { style: "currency", currency: "CAD" });

export const dateTime = (iso) =>
  iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "—";
