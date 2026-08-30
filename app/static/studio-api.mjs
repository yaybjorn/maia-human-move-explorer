const ROUTES = Object.freeze({
  session: "/session",
  login: "/login",
  logout: "/logout",
  courses: "/courses",
  course: id => `/courses/${encodeURIComponent(id)}`,
  draft: id => `/courses/${encodeURIComponent(id)}/draft`,
  validate: id => `/courses/${encodeURIComponent(id)}/validate`,
  publish: id => `/courses/${encodeURIComponent(id)}/publish`,
  versions: id => `/courses/${encodeURIComponent(id)}/versions`,
  restore: (id, versionID) => `/courses/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionID)}/restore`,
});

export class StudioAPIError extends Error {
  constructor(message, { status = 0, code = "request_failed", details = null } = {}) {
    super(message);
    this.name = "StudioAPIError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class StudioAPI {
  constructor(base = "/studio/api", fetcher = globalThis.fetch?.bind(globalThis)) {
    this.base = base.replace(/\/$/, "");
    this.fetcher = fetcher;
    this.csrfToken = null;
    this.onUnauthorized = null;
  }

  async request(path, { method = "GET", body, mutation = !["GET", "HEAD"].includes(method) } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (mutation && this.csrfToken) headers["X-CSRF-Token"] = this.csrfToken;
    let response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new StudioAPIError("The Course Studio is temporarily unreachable.", { code: "network_error" });
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const error = new StudioAPIError(
        data?.detail || data?.message || "The request could not be completed.",
        { status: response.status, code: data?.code, details: data?.errors || data?.details },
      );
      if (response.status === 401 && this.onUnauthorized) this.onUnauthorized(error);
      throw error;
    }
    if (data?.csrfToken) this.csrfToken = data.csrfToken;
    return data;
  }

  session() { return this.request(ROUTES.session); }
  login(email, password) { return this.request(ROUTES.login, { method: "POST", body: { email, password } }); }
  logout() { return this.request(ROUTES.logout, { method: "POST" }); }
  courses() { return this.request(ROUTES.courses); }
  course(id) { return this.request(ROUTES.course(id)); }
  createCourse(input) { return this.request(ROUTES.courses, { method: "POST", body: input }); }
  saveDraft(id, revision, document) {
    return this.request(ROUTES.draft(id), { method: "PUT", body: { revision, document } });
  }
  validateCourse(id, revision, document) {
    return this.request(ROUTES.validate(id), { method: "POST", body: { revision, document } });
  }
  publishCourse(id, revision) {
    return this.request(ROUTES.publish(id), { method: "POST", body: { revision } });
  }
  versions(id) { return this.request(ROUTES.versions(id)); }
  restoreVersion(id, versionID, revision) {
    return this.request(ROUTES.restore(id, versionID), { method: "POST", body: { revision } });
  }
}

export const studioRoutes = ROUTES;

async function localRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new StudioAPIError(data?.detail || "Analysis failed.", { status: response.status });
  return data;
}

export const analysisAPI = Object.freeze({
  parsePGN: pgn => localRequest("/api/parse-pgn", { pgn }),
  exportPGN: (nodes, headers) => localRequest("/api/export-pgn", { nodes, headers }),
  position: moves => localRequest("/api/state", { moves }),
  maia: (moves, rating, opponentRating) => localRequest("/api/predict", {
    moves, rating, opponent_rating: opponentRating,
  }),
  stockfish: moves => localRequest("/api/stockfish", { moves }),
  repertoireGaps: (pgn, repertoireSide, rating, threshold) => localRequest("/api/check-repertoire", {
    pgn, repertoire_side: repertoireSide, rating, threshold,
  }),
});
