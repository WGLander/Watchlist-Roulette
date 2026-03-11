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

function buildTmdbSearchUrl(query: string): string {
  const { token, key } = getTmdbCreds();
  if (!token && !key) {
    throw new Error("Missing TMDB credentials.");
  }
  const params = new URLSearchParams({ query });
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

async function searchTmdbMovie(title: string): Promise<number | null> {
  try {
    const url = buildTmdbSearchUrl(title);
    const res = await fetch(url, { headers: tmdbHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const first = Array.isArray(data.results) ? data.results[0] : null;
    return typeof first?.id === "number" ? first.id : null;
  } catch (err) {
    console.error("[tmdb] search failed", err);
    return null;
  }
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").trim();
}

async function scrapeFilmMeta(slug: string, name?: string): Promise<FilmMeta> {
  const title = name?.trim() || slugToTitle(slug);
  if (!title) return { genres: [], runtime: null };
  const id = await searchTmdbMovie(title);
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
