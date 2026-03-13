import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const CONCURRENT_LIMIT = 3;
const MAX_TMDB_RETRIES = 2;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_CONCURRENT_TMDB = 2;
const MIN_TMDB_INTERVAL_MS = 250;
let tmdbInFlight = 0;
let tmdbLastStart = 0;
const tmdbWaiters: Array<() => void> = [];
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function getTmdbCreds(): { token?: string; key?: string } {
  try {
    const env = typeof process !== "undefined" ? process.env : undefined;
    return {
      token: env?.TMDB_READ_ACCESS_TOKEN,
      key: env?.TMDB_API_KEY,
    };
  } catch {
    return {};
  }
}

function buildTmdbUrl(id: string): string {
  const { token, key } = getTmdbCreds();
  if (!token && !key) {
    throw new Error("Missing TMDB credentials.");
  }
  const base = `https://api.themoviedb.org/3/movie/${id}`;
  return key ? `${base}?api_key=${key}` : base;
}

function tmdbHeaders(): Record<string, string> {
  const { token } = getTmdbCreds();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function buildTmdbSearchUrl(query: string, year?: string): string {
  const { token, key } = getTmdbCreds();
  if (!token && !key) {
    throw new Error("Missing TMDB credentials.");
  }
  const params = new URLSearchParams({
    query,
    include_adult: "false",
    language: "en-US",
    page: "1",
  });
  if (year) params.set("primary_release_year", year);
  if (key) params.set("api_key", key);
  return `https://api.themoviedb.org/3/search/movie?${params.toString()}`;
}

type TmdbCallStats = {
  ok: number;
  fail: number;
  retries: number;
  statusCounts: Record<string, number>;
};

type TmdbStats = {
  search: TmdbCallStats;
  details: TmdbCallStats;
};

function createTmdbStats(): TmdbStats {
  return {
    search: { ok: 0, fail: 0, retries: 0, statusCounts: {} },
    details: { ok: 0, fail: 0, retries: 0, statusCounts: {} },
  };
}

function getRetryDelayMs(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const parsed = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(10_000, parsed * 1000);
    }
  }
  return Math.min(10_000, 500 * (attempt + 1) ** 2);
}

async function fetchLetterboxdPage(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      if (res.ok) return await res.text();
      if ([403, 429, 503, 520, 521, 522].includes(res.status)) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return null;
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

function decodeHtml(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, code) => {
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: "\"",
      apos: "'",
    };
    if (code in named) return named[code];
    if (code.startsWith("#x")) {
      const num = parseInt(code.slice(2), 16);
      return Number.isNaN(num) ? match : String.fromCodePoint(num);
    }
    if (code.startsWith("#")) {
      const num = parseInt(code.slice(1), 10);
      return Number.isNaN(num) ? match : String.fromCodePoint(num);
    }
    return match;
  });
}

function parseDurationToMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(trimmed);
  if (iso) {
    const hours = iso[1] ? parseInt(iso[1], 10) : 0;
    const mins = iso[2] ? parseInt(iso[2], 10) : 0;
    const total = hours * 60 + mins;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const hm = /(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(trimmed);
  if (hm) {
    const hours = parseInt(hm[1], 10);
    const mins = hm[2] ? parseInt(hm[2], 10) : 0;
    const total = hours * 60 + mins;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const mins = /(\d{1,3})\s*mins?\b/i.exec(trimmed);
  if (mins) {
    const total = parseInt(mins[1], 10);
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  return null;
}

async function acquireTmdbSlot(): Promise<void> {
  while (tmdbInFlight >= MAX_CONCURRENT_TMDB) {
    await new Promise<void>((resolve) => tmdbWaiters.push(resolve));
  }
  tmdbInFlight += 1;
  const now = Date.now();
  const wait = Math.max(0, tmdbLastStart + MIN_TMDB_INTERVAL_MS - now);
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  tmdbLastStart = Date.now();
}

function releaseTmdbSlot(): void {
  tmdbInFlight = Math.max(0, tmdbInFlight - 1);
  const next = tmdbWaiters.shift();
  if (next) next();
}

async function fetchTmdbJson(
  url: string,
  kind: keyof TmdbStats,
  stats?: TmdbStats
): Promise<any | null> {
  for (let attempt = 0; attempt < MAX_TMDB_RETRIES; attempt++) {
    await acquireTmdbSlot();
    let res: Response | null = null;
    try {
      res = await fetch(url, { headers: tmdbHeaders() });
    } catch {
      res = null;
    } finally {
      releaseTmdbSlot();
    }
    if (res?.ok) {
      if (stats) stats[kind].ok += 1;
      return res.json();
    }
    const statusKey = res ? String(res.status) : "fetch_error";
    if (stats) {
      stats[kind].statusCounts[statusKey] =
        (stats[kind].statusCounts[statusKey] || 0) + 1;
    }
    if (!res || !RETRY_STATUSES.has(res.status)) {
      if (stats) stats[kind].fail += 1;
      return null;
    }
    if (stats) stats[kind].retries += 1;
    const delay = getRetryDelayMs(attempt, res.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, delay));
  }
  if (stats) stats[kind].fail += 1;
  return null;
}

async function fetchTmdbMovie(
  id: number,
  stats?: TmdbStats
): Promise<FilmMeta> {
  try {
    console.log(`[tmdb] fetch movie ${id}`);
    const url = buildTmdbUrl(String(id));
    const data = await fetchTmdbJson(url, "details", stats);
    if (!data) return { genres: [], runtime: null };
    const genres = Array.isArray(data.genres)
      ? data.genres.map((g: { name?: string }) => g.name).filter(Boolean)
      : [];
    const runtime =
      typeof data.runtime === "number" && Number.isFinite(data.runtime)
        ? data.runtime
        : null;
    return { genres, runtime };
  } catch (err) {
    console.error("[tmdb] fetch failed", err);
    return { genres: [], runtime: null };
  }
}

interface FilmMeta {
  genres: string[];
  runtime: number | null;
}

type LetterboxdMeta = {
  genres: string[];
  runtime: number | null;
};

function extractJsonLdNodes(data: unknown): Record<string, any>[] {
  const nodes: Record<string, any>[] = [];
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object") {
        nodes.push(item as Record<string, any>);
      }
    }
  } else if (data && typeof data === "object") {
    nodes.push(data as Record<string, any>);
  }
  const expanded: Record<string, any>[] = [];
  for (const node of nodes) {
    expanded.push(node);
    if (Array.isArray(node["@graph"])) {
      for (const child of node["@graph"]) {
        if (child && typeof child === "object") {
          expanded.push(child as Record<string, any>);
        }
      }
    }
  }
  return expanded;
}

function parseGenresFromHtml(html: string): string[] {
  const genres = new Set<string>();
  const regex = /<a[^>]+href="\/films\/genre\/[^"]+\/"[^>]*>([^<]+)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html))) {
    const name = decodeHtml(match[1]).trim();
    if (name) genres.add(name);
  }
  return [...genres];
}

function parseRuntimeFromHtml(html: string): number | null {
  const hm = /(\d+)\s*h(?:\s*(\d+)\s*m)?/i.exec(html);
  if (hm) {
    const hours = parseInt(hm[1], 10);
    const mins = hm[2] ? parseInt(hm[2], 10) : 0;
    const total = hours * 60 + mins;
    if (Number.isFinite(total) && total > 0) return total;
  }
  const mins = /(\d{1,3})\s*mins?\b/i.exec(html);
  if (mins) {
    const total = parseInt(mins[1], 10);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}

function parseLetterboxdMetaFromHtml(html: string): LetterboxdMeta {
  let genres: string[] = [];
  let runtime: number | null = null;

  const scripts = [...html.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi
  )];
  for (const match of scripts) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const nodes = extractJsonLdNodes(parsed);
      for (const node of nodes) {
        const type = node["@type"];
        const types = Array.isArray(type) ? type : [type];
        if (!types.some((t) => typeof t === "string" && /movie|film/i.test(t))) {
          continue;
        }
        if (genres.length === 0) {
          const g = node.genre;
          if (Array.isArray(g)) {
            genres = g.filter((item: unknown) => typeof item === "string");
          } else if (typeof g === "string") {
            genres = [g];
          }
        }
        if (runtime == null) {
          runtime = parseDurationToMinutes(node.duration);
        }
      }
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
    if (genres.length > 0 && runtime != null) break;
  }

  if (genres.length === 0) genres = parseGenresFromHtml(html);
  if (runtime == null) runtime = parseRuntimeFromHtml(html);

  return { genres, runtime };
}

async function fetchLetterboxdMeta(slug: string): Promise<LetterboxdMeta> {
  const url = `https://letterboxd.com/film/${slug}/`;
  const html = await fetchLetterboxdPage(url);
  if (!html) return { genres: [], runtime: null };
  return parseLetterboxdMetaFromHtml(html);
}

type TmdbSearchResult = {
  id?: number;
  title?: string;
  original_title?: string;
  release_date?: string;
};

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function extractYearFromSlug(slug: string): string | undefined {
  const match = slug.match(/-(\d{4})$/);
  return match ? match[1] : undefined;
}

function extractYearFromName(name: string): string | undefined {
  const match = name.match(/\((\d{4})\)\s*$/);
  return match ? match[1] : undefined;
}

function stripYearFromName(name: string): string {
  return name.replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

function stripYearSuffix(slug: string): string {
  return slug.replace(/-\d{4}$/, "");
}

function pickBestResult(
  results: TmdbSearchResult[],
  targetTitle: string,
  year?: string
): TmdbSearchResult | undefined {
  const target = normalizeTitle(targetTitle);
  let best: { score: number; item: TmdbSearchResult } | null = null;

  for (const item of results) {
    const title = item.title || "";
    const original = item.original_title || "";
    const normTitle = normalizeTitle(title);
    const normOriginal = normalizeTitle(original);
    let score = 0;

    if (normTitle === target || normOriginal === target) score += 3;
    else if (normTitle.includes(target) || target.includes(normTitle))
      score += 1;

    if (year && item.release_date?.startsWith(year)) score += 2;

    if (!best || score > best.score) best = { score, item };
  }

  return best?.item;
}

async function searchTmdbMovie(
  title: string,
  year: string | undefined,
  stats?: TmdbStats
): Promise<number | null> {
  try {
    const url = buildTmdbSearchUrl(title, year);
    const data = await fetchTmdbJson(url, "search", stats);
    if (!data) return null;
    const results: TmdbSearchResult[] = Array.isArray(data.results)
      ? data.results
      : [];
    if (results.length === 0) return null;
    const picked = pickBestResult(results, title, year) || results[0];
    return typeof picked?.id === "number" ? picked.id : null;
  } catch (err) {
    console.error("[tmdb] search failed", err);
    return null;
  }
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").trim();
}

async function scrapeFilmMeta(
  slug: string,
  name: string | undefined,
  stats?: TmdbStats
): Promise<FilmMeta> {
  const rawName = name?.trim() || "";
  const year = extractYearFromName(rawName) || extractYearFromSlug(slug);
  const hasName = rawName.length > 0;
  const title = hasName
    ? stripYearFromName(rawName)
    : slugToTitle(stripYearSuffix(slug));
  if (!title) return { genres: [], runtime: null };
  let id = await searchTmdbMovie(title, year, stats);
  if (!id && year) {
    id = await searchTmdbMovie(title, undefined, stats);
  }
  if (!id && !hasName) {
    const fallbackTitle = slugToTitle(stripYearSuffix(slug));
    if (fallbackTitle && fallbackTitle !== title) {
      id = await searchTmdbMovie(fallbackTitle, year, stats);
      if (!id && year) {
        id = await searchTmdbMovie(fallbackTitle, undefined, stats);
      }
    }
  }
  let tmdbMeta: FilmMeta = { genres: [], runtime: null };
  if (id) {
    tmdbMeta = await fetchTmdbMovie(id, stats);
  }

  if (tmdbMeta.genres.length > 0 && tmdbMeta.runtime != null) {
    return tmdbMeta;
  }

  const lbMeta = await fetchLetterboxdMeta(slug);
  return {
    genres: tmdbMeta.genres.length > 0 ? tmdbMeta.genres : lbMeta.genres,
    runtime: tmdbMeta.runtime != null ? tmdbMeta.runtime : lbMeta.runtime,
  };
}

export async function POST(request: NextRequest) {
  const { token, key } = getTmdbCreds();
  if (!token && !key) {
    return NextResponse.json(
      {
        error: "Missing TMDB credentials on the server.",
        envPresent: { token: false, key: false },
      },
      { status: 500 }
    );
  }

  let body: {
    slugs?: string[];
    items?: { slug: string; name?: string }[];
    debug?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const items: { slug: string; name?: string }[] =
    Array.isArray(body.items) && body.items.length > 0
      ? body.items
      : Array.isArray(body.slugs)
        ? body.slugs.map((slug) => ({ slug }))
        : [];
  const debug =
    body.debug === true || request.nextUrl.searchParams.get("debug") === "1";
  const tmdbStats = debug ? createTmdbStats() : undefined;

  if (items.length === 0) {
    return NextResponse.json(
      { error: "Missing 'items' or 'slugs' in request body." },
      { status: 400 }
    );
  }

  // Deduplicate
  const uniqueItems = Array.from(
    new Map(items.map((i) => [i.slug, i])).values()
  );
  const genreMap: Record<string, string[]> = {};
  const runtimeMap: Record<string, number | null> = {};
  const allGenresSet = new Set<string>();

  try {
    // Fetch in chunks
    for (let i = 0; i < uniqueItems.length; i += CONCURRENT_LIMIT) {
      const chunk = uniqueItems.slice(i, i + CONCURRENT_LIMIT);
      const results = await Promise.all(
        chunk.map(async (item) => ({
          slug: item.slug,
          meta: await scrapeFilmMeta(item.slug, item.name, tmdbStats),
        }))
      );
      for (const r of results) {
        genreMap[r.slug] = r.meta.genres;
        runtimeMap[r.slug] = r.meta.runtime;
        for (const g of r.meta.genres) allGenresSet.add(g);
      }
      if (i + CONCURRENT_LIMIT < uniqueItems.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    return NextResponse.json({
      genres: genreMap,
      runtimes: runtimeMap,
      allGenres: [...allGenresSet].sort(),
      ...(debug && tmdbStats ? { tmdbStats } : {}),
    });
  } catch (err) {
    console.error("[genres] handler failed", err);
    return NextResponse.json(
      {
        error: "TMDB lookup failed.",
        envPresent: { token: !!token, key: !!key },
        ...(debug && tmdbStats ? { tmdbStats } : {}),
      },
      { status: 500 }
    );
  }
}
