import { NextRequest, NextResponse } from "next/server";

export const runtime = 'edge';

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const CONCURRENT_LIMIT = 10;

async function fetchPage(url: string): Promise<string | null> {
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

interface FilmMeta {
  genres: string[];
  runtime: number | null;
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

async function scrapeFilmMeta(slug: string): Promise<FilmMeta> {
  const html = await fetchPage(`https://letterboxd.com/film/${slug}/`);
  if (!html) return { genres: [], runtime: null };

  // Parse genres from the JSON-LD script tag (most reliable source)
  // Letterboxd wraps JSON-LD in CDATA comments: /* <![CDATA[ */ {...} /* ]]> */
  let genres: string[] = [];
  let ldScript =
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(
      html
    )?.[1] || "";
  if (ldScript) {
    ldScript = ldScript.replace(/\/\*.*?\*\//g, "").trim();
    try {
      const ld = JSON.parse(ldScript);
      if (Array.isArray(ld.genre)) genres = ld.genre;
    } catch {
      // fall through
    }
  }

  // Parse runtime from the footer text (e.g. "175 mins")
  let runtime: number | null = null;
  const footerHtml =
    /<p[^>]*class="[^"]*text-footer[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(
      html
    )?.[1] || "";
  const footerText = decodeHtml(footerHtml.replace(/<[^>]+>/g, " "));
  const match = footerText.match(/(\d+)\s*mins?/);
  if (match) runtime = parseInt(match[1], 10);

  return { genres, runtime };
}

export async function POST(request: NextRequest) {
  let body: { slugs?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  const slugs = body.slugs;
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return NextResponse.json(
      { error: "Missing 'slugs' array in request body." },
      { status: 400 }
    );
  }

  // Deduplicate
  const uniqueSlugs = [...new Set(slugs)];
  const genreMap: Record<string, string[]> = {};
  const runtimeMap: Record<string, number | null> = {};
  const allGenresSet = new Set<string>();

  // Fetch in chunks
  for (let i = 0; i < uniqueSlugs.length; i += CONCURRENT_LIMIT) {
    const chunk = uniqueSlugs.slice(i, i + CONCURRENT_LIMIT);
    const results = await Promise.all(
      chunk.map(async (slug) => ({
        slug,
        meta: await scrapeFilmMeta(slug),
      }))
    );
    for (const r of results) {
      genreMap[r.slug] = r.meta.genres;
      runtimeMap[r.slug] = r.meta.runtime;
      for (const g of r.meta.genres) allGenresSet.add(g);
    }
    if (i + CONCURRENT_LIMIT < uniqueSlugs.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return NextResponse.json({
    genres: genreMap,
    runtimes: runtimeMap,
    allGenres: [...allGenresSet].sort(),
  });
}
