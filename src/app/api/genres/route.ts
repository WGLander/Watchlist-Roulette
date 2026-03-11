import { NextRequest, NextResponse } from "next/server";

export const runtime = 'edge';

const CONCURRENT_LIMIT = 10;

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

async function fetchTmdbMovie(id: number): Promise<FilmMeta> {
  try {
    console.log(`[tmdb] fetch movie ${id}`);
    const url = buildTmdbUrl(String(id));
    const res = await fetch(url, { headers: tmdbHeaders() });
    if (!res.ok) return { genres: [], runtime: null };
    const data = await res.json();
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
  year?: string
): Promise<number | null> {
  try {
    const url = buildTmdbSearchUrl(title, year);
    const res = await fetch(url, { headers: tmdbHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
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

async function scrapeFilmMeta(slug: string, name?: string): Promise<FilmMeta> {
  const year = extractYearFromSlug(slug);
  const title = name?.trim() || slugToTitle(stripYearSuffix(slug));
  if (!title) return { genres: [], runtime: null };
  let id = await searchTmdbMovie(title, year);
  if (!id && year) {
    id = await searchTmdbMovie(title);
  }
  if (!id && title !== slugToTitle(stripYearSuffix(slug))) {
    const fallbackTitle = slugToTitle(stripYearSuffix(slug));
    id = await searchTmdbMovie(fallbackTitle, year);
    if (!id && year) {
      id = await searchTmdbMovie(fallbackTitle);
    }
  }
  if (!id) return { genres: [], runtime: null };
  return fetchTmdbMovie(id);
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

  let body: { slugs?: string[]; items?: { slug: string; name?: string }[] };
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
          meta: await scrapeFilmMeta(item.slug, item.name),
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
    });
  } catch (err) {
    console.error("[genres] handler failed", err);
    return NextResponse.json(
      {
        error: "TMDB lookup failed.",
        envPresent: { token: !!token, key: !!key },
      },
      { status: 500 }
    );
  }
}
