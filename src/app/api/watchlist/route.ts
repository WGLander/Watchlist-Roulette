import { NextRequest, NextResponse } from "next/server";

export const runtime = 'edge';

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

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

function getPageCount(html: string): number {
  const matches = [...html.matchAll(
    /<li[^>]*class="[^"]*paginate-page[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\d,]+)<\/a>/gi
  )];
  if (matches.length === 0) return 1;
  const last = matches[matches.length - 1]?.[1]?.replace(/,/g, "");
  const parsed = last ? parseInt(last, 10) : NaN;
  return Number.isNaN(parsed) ? 1 : parsed;
}

function parseWatchlistPage(html: string): { name: string; slug: string }[] {
  const films: { name: string; slug: string }[] = [];
  const tagRegex = /<div[^>]*class="[^"]*react-component[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html))) {
    const tag = match[0];
    const nameMatch =
      /data-item-name="([^"]*)"/i.exec(tag) ||
      /data-item-full-display-name="([^"]*)"/i.exec(tag);
    const slugMatch = /data-item-slug="([^"]*)"/i.exec(tag);
    const name = nameMatch ? decodeHtml(nameMatch[1]) : "";
    const slug = slugMatch ? decodeHtml(slugMatch[1]) : "";
    if (name && slug) films.push({ name, slug });
  }

  return films;
}

interface UserWatchlistResult {
  username: string;
  films: { name: string; slug: string }[];
  error?: string;
}

async function scrapeUserWatchlist(
  username: string
): Promise<UserWatchlistResult> {
  const firstPageUrl = `https://letterboxd.com/${username}/watchlist/`;
  const firstPageHtml = await fetchPage(firstPageUrl);

  if (!firstPageHtml) {
    return { username, films: [], error: `Could not fetch watchlist for '${username}'.` };
  }

  const bodyClass =
    /<body[^>]*class="([^"]*)"/i.exec(firstPageHtml)?.[1] || "";
  if (bodyClass.includes("error")) {
    return { username, films: [], error: `User '${username}' not found on Letterboxd.` };
  }

  const numPages = getPageCount(firstPageHtml);
  const allFilms = parseWatchlistPage(firstPageHtml);

  if (numPages > 1) {
    const urls = Array.from({ length: numPages - 1 }, (_, i) =>
      `https://letterboxd.com/${username}/watchlist/page/${i + 2}/`
    );
    const pages = await Promise.all(urls.map((url) => fetchPage(url)));
    for (const html of pages) {
      if (html) allFilms.push(...parseWatchlistPage(html));
    }
  }

  return { username, films: allFilms };
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("usernames")?.trim();

  if (!raw) {
    return NextResponse.json(
      { error: "Missing 'usernames' query parameter." },
      { status: 400 }
    );
  }

  const usernames = [
    ...new Set(
      raw
        .split(",")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];

  if (usernames.length === 0) {
    return NextResponse.json(
      { error: "No valid usernames provided." },
      { status: 400 }
    );
  }

  // Scrape all users' watchlists concurrently
  const results = await Promise.all(usernames.map(scrapeUserWatchlist));

  // Check for errors
  const errors = results.filter((r) => r.error);
  if (errors.length === results.length) {
    return NextResponse.json(
      { error: errors.map((e) => e.error).join(" ") },
      { status: 404 }
    );
  }

  // Build per-user data (no genres — those are fetched separately on demand)
  const users = results.map((r) => ({
    username: r.username,
    count: r.films.length,
    movies: r.films.map((f) => ({ name: f.name, slug: f.slug })),
    error: r.error || null,
  }));

  // Compute shared films (intersection by slug across successful users)
  const successfulUsers = results.filter((r) => !r.error);
  let shared: { name: string; slug: string }[] = [];

  if (successfulUsers.length >= 2) {
    const sets = successfulUsers.map((r) => new Set(r.films.map((f) => f.slug)));
    const firstUser = successfulUsers[0];
    shared = firstUser.films.filter((f) =>
      sets.slice(1).every((s) => s.has(f.slug))
    );
  }

  return NextResponse.json({
    users,
    shared,
    sharedCount: shared.length,
  });
}
