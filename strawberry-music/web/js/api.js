/* ==========================================================================
   API client
   ========================================================================== */

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      const raw = data?.detail;
      if (Array.isArray(raw)) {
        detail = raw
          .map((item) => item?.msg || item?.message || "")
          .filter(Boolean)
          .join("; ");
      } else if (typeof raw === "string") {
        detail = raw;
      } else if (raw && typeof raw === "object") {
        detail = raw.message || "";
      }
    } catch {
      /* ignore */
    }
    const error = new Error(detail || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export const api = {
  home: () => request("/api/home"),
  explore: () => request("/api/explore"),

  search: (query, type = "all", limit = 20) => {
    const params = new URLSearchParams({ q: query, type, limit: String(limit) });
    return request(`/api/search?${params}`);
  },

  suggestions: (query) =>
    request(`/api/suggestions?q=${encodeURIComponent(query)}`).then((data) => data.items || []),

  artist: (id) => request(`/api/artist/${encodeURIComponent(id)}`),
  album: (id) => request(`/api/album/${encodeURIComponent(id)}`),
  playlist: (id, limit = 500) =>
    request(`/api/playlist/${encodeURIComponent(id)}?limit=${limit}`),
  watch: (videoId, limit = 50) =>
    request(`/api/watch/${encodeURIComponent(videoId)}?limit=${limit}`),
  radio: (videoId, seed = null) => {
    const params = new URLSearchParams();
    if (seed?.title) params.set("title", seed.title);
    const artist =
      seed?.artistText ||
      (seed?.artists || [])
        .map((item) => item?.name)
        .filter(Boolean)
        .join(", ");
    if (artist) params.set("artist", artist);
    const artistId = (seed?.artists || []).find((item) => item?.id)?.id;
    if (artistId) params.set("artistId", artistId);
    const query = params.toString();
    return request(
      `/api/radio/${encodeURIComponent(videoId)}${query ? `?${query}` : ""}`
    );
  },

  lyrics: ({ videoId, title, artistText, album, durationSeconds }) => {
    const params = new URLSearchParams({
      videoId,
      title: title || "",
      artist: artistText || "",
      album: album?.name || "",
      duration: String(durationSeconds || 0),
    });
    return request(`/api/lyrics?${params}`);
  },

  prefetch: (videoId) => {
    fetch(`/api/prefetch/${encodeURIComponent(videoId)}`, { method: "POST" }).catch(() => {});
  },

  health: () => request("/api/health"),

  authStatus: () => request("/api/auth"),
  authConnect: (headers) =>
    request("/api/auth/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers }),
    }),
  authDisconnect: () =>
    request("/api/auth/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
};
