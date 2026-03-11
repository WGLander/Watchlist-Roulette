"use client";

import { useState, useMemo, useCallback, useEffect, FormEvent } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import {
  Search,
  Loader2,
  Film,
  Plus,
  X,
  Users,
  RotateCcw,
  Sparkles,
  Tag,
  Clock,
  List,
  ChevronDown,
} from "lucide-react";

const SpinWheel = dynamic(() => import("./components/SpinWheel"), {
  ssr: false,
});

type ListFilter = "all" | "mutual";

interface FilmEntry {
  name: string;
  slug: string;
}

interface UserResult {
  username: string;
  count: number;
  movies: FilmEntry[];
  error: string | null;
}

export default function Home() {
  const [inputs, setInputs] = useState([""]);
  const [users, setUsers] = useState<UserResult[]>([]);
  const [shared, setShared] = useState<FilmEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [result, setResult] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"wheel" | "list">("wheel");
  const [genreDropdownOpen, setGenreDropdownOpen] = useState(false);
  const [runtimeDropdownOpen, setRuntimeDropdownOpen] = useState(false);

  // Filter data — fetched once on first filter toggle
  const [genreMap, setGenreMap] = useState<Record<string, string[]>>({});
  const [runtimeMap, setRuntimeMap] = useState<Record<string, number | null>>(
    {},
  );
  const [allGenres, setAllGenres] = useState<string[]>([]);
  const [dataFetched, setDataFetched] = useState(false);
  const [dataFetching, setDataFetching] = useState(false);

  const [selectedGenres, setSelectedGenres] = useState<Set<string>>(new Set());
  const [runtimeMin, setRuntimeMin] = useState<number>(0);
  const [runtimeMax, setRuntimeMax] = useState<number>(999);
  const [runtimeRange, setRuntimeRange] = useState<[number, number]>([0, 999]);

  function updateInput(index: number, value: string) {
    setInputs((prev) => prev.map((v, i) => (i === index ? value : v)));
  }

  function addInput() {
    setInputs((prev) => [...prev, ""]);
  }

  function removeInput(index: number) {
    if (inputs.length <= 1) return;
    setInputs((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleGenre(genre: string) {
    setSelectedGenres((prev) => {
      const next = new Set(prev);
      if (next.has(genre)) next.delete(genre);
      else next.add(genre);
      return next;
    });
    setResult(null);
  }

  function clearGenres() {
    setSelectedGenres(new Set());
    setResult(null);
  }

  const validUsernames = inputs.map((u) => u.trim()).filter(Boolean);
  const isMultiUser = users.length > 1;

  // Combine all films (deduplicated by slug)
  const allFilms = useMemo(() => {
    const seen = new Set<string>();
    const combined: FilmEntry[] = [];
    for (const u of users) {
      if (u.error) continue;
      for (const m of u.movies) {
        if (!seen.has(m.slug)) {
          seen.add(m.slug);
          combined.push(m);
        }
      }
    }
    return combined;
  }, [users]);

  // Apply list filter (all vs mutual), then genre filter
  const wheelFilms = useMemo(() => {
    let pool: FilmEntry[];
    if (isMultiUser && listFilter === "mutual") {
      pool = shared;
    } else {
      pool = allFilms;
    }

    if (dataFetched && selectedGenres.size > 0) {
      pool = pool.filter((f) => {
        const genres = genreMap[f.slug] || [];
        return [...selectedGenres].every((g) => genres.includes(g));
      });
    }

    if (
      dataFetched &&
      (runtimeRange[0] > runtimeMin || runtimeRange[1] < runtimeMax)
    ) {
      pool = pool.filter((f) => {
        const rt = runtimeMap[f.slug];
        if (rt == null) return true;
        return rt >= runtimeRange[0] && rt <= runtimeRange[1];
      });
    }

    return pool;
  }, [
    isMultiUser,
    listFilter,
    allFilms,
    shared,
    dataFetched,
    selectedGenres,
    genreMap,
    runtimeMap,
    runtimeRange,
    runtimeMin,
    runtimeMax,
  ]);

  const wheelNames = useMemo(() => wheelFilms.map((f) => f.name), [wheelFilms]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (validUsernames.length < 1) return;

    setLoading(true);
    setError("");
    setUsers([]);
    setShared([]);
    setLoaded(false);
    setResult(null);
    setGenreMap({});
    setRuntimeMap({});
    setAllGenres([]);
    setSelectedGenres(new Set());
    setDataFetched(false);
    setRuntimeRange([0, 999]);

    try {
      const res = await fetch(
        `/api/watchlist?usernames=${encodeURIComponent(validUsernames.join(","))}`,
      );
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return;
      }

      setUsers(data.users);
      setShared(data.shared);
      setLoaded(true);
      if (data.users.length > 1 && data.shared.length > 0) {
        setListFilter("mutual");
      } else {
        setListFilter("all");
      }
    } catch {
      setError("Failed to fetch watchlists. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const fetchFilterData = useCallback(async () => {
    if (dataFetched || dataFetching) return;
    setDataFetching(true);

    try {
      const items = allFilms.map((f) => ({ slug: f.slug, name: f.name }));
      const chunkSize = 10;
      const mergedGenres: Record<string, string[]> = {};
      const mergedRuntimes: Record<string, number | null> = {};
      const mergedGenreSet = new Set<string>();
      let hadSuccess = false;

      for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        try {
          const res = await fetch("/api/genres", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: chunk }),
          });
          if (!res.ok) continue;
          const data = await res.json();
          hadSuccess = true;

          for (const [slug, genres] of Object.entries<string[]>(
            data.genres || {},
          )) {
            mergedGenres[slug] = genres;
            for (const g of genres) mergedGenreSet.add(g);
          }

          for (const [slug, runtime] of Object.entries<number | null>(
            data.runtimes || {},
          )) {
            mergedRuntimes[slug] = runtime;
          }
        } catch {
          // ignore failed chunk
        }
      }

      if (hadSuccess) {
        setGenreMap(mergedGenres);
        setRuntimeMap(mergedRuntimes);
        setAllGenres([...mergedGenreSet].sort());

        const validRuntimes = Object.values(mergedRuntimes).filter(
          (r): r is number => r != null,
        );
        if (validRuntimes.length > 0) {
          const min = Math.min(...validRuntimes);
          const max = Math.max(...validRuntimes);
          setRuntimeMin(min);
          setRuntimeMax(max);
          setRuntimeRange([min, max]);
        }

        setDataFetched(true);
      }
    } catch {
      // silently fail
    } finally {
      setDataFetching(false);
    }
  }, [allFilms, dataFetched, dataFetching]);

  useEffect(() => {
    if (!loaded || dataFetched || dataFetching || allFilms.length === 0) return;
    void fetchFilterData();
  }, [loaded, dataFetched, dataFetching, allFilms.length, fetchFilterData]);

  function handleReset() {
    setUsers([]);
    setShared([]);
    setLoaded(false);
    setResult(null);
    setError("");
    setGenreMap({});
    setRuntimeMap({});
    setAllGenres([]);
    setSelectedGenres(new Set());
    setDataFetched(false);
    setRuntimeRange([0, 999]);
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10 sm:py-16">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="flex items-center justify-center mb-2">
          <Image
            src="/title.png"
            alt="Watchlist Roulette"
            width={500}
            height={250}
            priority
            className="max-w-full h-auto"
          />
        </div>
        <p className="text-muted text-base sm:text-lg">
          Spin the wheel to pick a film from your Letterboxd watchlist
        </p>
      </div>

      {/* Username inputs — shown when wheel not loaded */}
      {!loaded && !loading && (
        <form onSubmit={handleSubmit} className="w-full max-w-[490px] mb-8">
          <div className="flex flex-col gap-2 mb-3">
            {inputs.map((val, i) => (
              <div key={i} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
                  <input
                    type="text"
                    placeholder={
                      inputs.length === 1
                        ? "Letterboxd username"
                        : `Username ${i + 1}`
                    }
                    value={val}
                    onChange={(e) => updateInput(i, e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-input border border-border text-foreground placeholder:text-muted text-sm focus:outline-none focus:border-accent transition-colors"
                  />
                </div>
                {inputs.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeInput(i)}
                    className="px-2.5 rounded-lg border border-border text-muted hover:text-red-500 hover:border-red-500/50 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={addInput}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-muted hover:text-foreground hover:border-accent text-sm font-medium transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {inputs.length < 2 ? "Add another user" : "Add user"}
            </button>

            <button
              type="submit"
              disabled={loading || validUsernames.length < 1}
              className="flex-1 py-2.5 rounded-lg bg-accent text-accent-foreground font-semibold text-sm hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {validUsernames.length >= 2 ? (
                <>
                  <Users className="w-4 h-4" />
                  Load Watchlists
                </>
              ) : (
                <>
                  <Search className="w-4 h-4" />
                  Load Watchlist
                </>
              )}
            </button>
          </div>
        </form>
      )}

      {/* Error */}
      {error && (
        <div className="w-full max-w-md mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center gap-3 text-muted py-12">
          <Loader2 className="w-6 h-6 animate-spin text-accent" />
          <p className="text-sm">
            {validUsernames.length === 1
              ? "Obtaining watchlist..."
              : "Obtaining watchlists..."}
          </p>
        </div>
      )}

      {/* Wheel section */}
      {loaded && !loading && (
        <div className="flex flex-col items-center gap-6 w-full max-w-2xl">
          {/* Users summary + toggles */}
          <div className="inline-flex flex-col items-stretch gap-4 max-w-[500px]">
            {/* Users summary + back button */}
            <div className="flex items-center gap-3 flex-wrap justify-center">
              <button
                onClick={handleReset}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted hover:text-foreground border border-border hover:border-accent/50 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                New search
              </button>
              {users
                .filter((u) => !u.error)
                .map((u) => (
                  <span
                    key={u.username}
                    className="px-3 py-1.5 rounded-md bg-accent text-accent-foreground text-xs"
                  >
                    {u.username} <span className="opacity-70">({u.count})</span>
                  </span>
                ))}
            </div>

            {/* Filter and view toggles */}
            <div className="flex flex-col items-stretch gap-2">
              {/* List filter toggle — only for multi-user */}
              {isMultiUser && (
                <div className="flex items-center gap-1 rounded-lg bg-card border border-border p-1">
                  <button
                    onClick={() => {
                      setListFilter("all");
                      setResult(null);
                    }}
                    className={`flex-1 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      listFilter === "all"
                        ? "bg-accent text-accent-foreground"
                        : "text-muted hover:text-foreground"
                    }`}
                  >
                    All films ({allFilms.length})
                  </button>
                  <button
                    onClick={() => {
                      setListFilter("mutual");
                      setResult(null);
                    }}
                    disabled={shared.length === 0}
                    className={`flex-1 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      listFilter === "mutual"
                        ? "bg-accent text-accent-foreground"
                        : "text-muted hover:text-foreground"
                    } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    Mutual only ({shared.length})
                  </button>
                </div>
              )}

              {/* View toggle */}
              <div className="flex items-center gap-1 rounded-lg bg-card border border-border p-1">
                <button
                  onClick={() => setViewMode("wheel")}
                  className={`flex-1 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    viewMode === "wheel"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <Film className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
                  Wheel
                </button>
                <button
                  onClick={() => setViewMode("list")}
                  className={`flex-1 px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    viewMode === "list"
                      ? "bg-accent text-accent-foreground"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  <List className="w-3.5 h-3.5 inline-block mr-1.5 -mt-0.5" />
                  List
                </button>
              </div>
            </div>
          </div>

          {/* Filter dropdowns */}
          <div className="w-full max-w-[500px] space-y-3">
            {/* Genre filter dropdown */}
            <div className="overflow-hidden">
              <button
                onClick={() => {
                  if (!dataFetched && !dataFetching) {
                    fetchFilterData();
                  }
                  setGenreDropdownOpen(!genreDropdownOpen);
                }}
                className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border text-muted hover:text-foreground text-sm font-medium transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Tag className="w-4 h-4" />
                  <span>Filter by genre</span>
                  {selectedGenres.size > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-accent text-accent-foreground text-xs">
                      {selectedGenres.size}
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${genreDropdownOpen ? "rotate-180" : ""}`}
                />
              </button>

              {genreDropdownOpen && (
                <div className="px-4 pb-4 animate-dropdown">
                  {dataFetching && (
                    <div className="flex items-center justify-center gap-2 text-muted py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-accent" />
                      <span className="text-sm">
                        Loading genres (this may take a while)...
                      </span>
                    </div>
                  )}

                  {dataFetched && allGenres.length > 0 && (
                    <>
                      {selectedGenres.size > 0 && (
                        <div className="flex items-center justify-end mb-3 pt-4">
                          <button
                            onClick={clearGenres}
                            className="text-xs text-accent hover:text-accent-hover transition-colors"
                          >
                            Clear all
                          </button>
                        </div>
                      )}
                      <div
                        className={`flex flex-wrap gap-1.5 ${selectedGenres.size > 0 ? "" : "pt-4"}`}
                      >
                        {allGenres.map((genre) => (
                          <button
                            key={genre}
                            onClick={() => toggleGenre(genre)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                              selectedGenres.has(genre)
                                ? "bg-accent text-accent-foreground"
                                : "bg-background border border-border text-muted hover:text-foreground hover:border-accent/50"
                            }`}
                          >
                            {genre}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Runtime filter dropdown */}
            <div className="overflow-hidden">
              <button
                onClick={() => {
                  if (!dataFetched && !dataFetching) {
                    fetchFilterData();
                  }
                  setRuntimeDropdownOpen(!runtimeDropdownOpen);
                }}
                className="w-full flex items-center justify-between px-4 py-2.5 border-b border-border text-muted hover:text-foreground text-sm font-medium transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  <span>Filter by runtime</span>
                  {dataFetched &&
                    (runtimeRange[0] > runtimeMin ||
                      runtimeRange[1] < runtimeMax) && (
                      <span className="text-xs text-foreground">
                        ({runtimeRange[0]}&ndash;{runtimeRange[1]} mins)
                      </span>
                    )}
                </div>
                <ChevronDown
                  className={`w-4 h-4 transition-transform ${runtimeDropdownOpen ? "rotate-180" : ""}`}
                />
              </button>

              {runtimeDropdownOpen && (
                <div className="px-4 pb-4 animate-dropdown">
                  {dataFetching && (
                    <div className="flex items-center justify-center gap-2 text-muted py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-accent" />
                      <span className="text-sm">
                        Loading runtime data (this may take a while)...
                      </span>
                    </div>
                  )}

                  {dataFetched && runtimeMax > runtimeMin && (
                    <>
                      <div className="flex items-center justify-between mb-3 pt-4">
                        <span className="text-xs font-medium text-muted">
                          Select runtime range
                        </span>
                        <span className="text-xs text-foreground">
                          {runtimeRange[0]}&ndash;{runtimeRange[1]} mins
                        </span>
                        {(runtimeRange[0] > runtimeMin ||
                          runtimeRange[1] < runtimeMax) && (
                          <button
                            onClick={() => {
                              setRuntimeRange([runtimeMin, runtimeMax]);
                              setResult(null);
                            }}
                            className="text-xs text-accent hover:text-accent-hover transition-colors"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted w-10 text-right">
                          {runtimeMin}
                        </span>
                        <div className="flex-1 flex flex-col gap-2">
                          <input
                            type="range"
                            min={runtimeMin}
                            max={runtimeMax}
                            value={runtimeRange[0]}
                            onChange={(e) => {
                              const val = Math.min(
                                Number(e.target.value),
                                runtimeRange[1],
                              );
                              setRuntimeRange([val, runtimeRange[1]]);
                              setResult(null);
                            }}
                            className="w-full accent-[var(--accent)] h-1.5"
                          />
                          <input
                            type="range"
                            min={runtimeMin}
                            max={runtimeMax}
                            value={runtimeRange[1]}
                            onChange={(e) => {
                              const val = Math.max(
                                Number(e.target.value),
                                runtimeRange[0],
                              );
                              setRuntimeRange([runtimeRange[0], val]);
                              setResult(null);
                            }}
                            className="w-full accent-[var(--accent)] h-1.5"
                          />
                        </div>
                        <span className="text-xs text-muted w-10">
                          {runtimeMax}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Match count */}
          {dataFetched &&
            (selectedGenres.size > 0 ||
              runtimeRange[0] > runtimeMin ||
              runtimeRange[1] < runtimeMax) && (
              <p className="text-xs text-muted">
                {wheelFilms.length} {wheelFilms.length === 1 ? "film" : "films"}{" "}
                matching
              </p>
            )}

          {/* Wheel / List view */}
          {wheelNames.length > 0 ? (
            viewMode === "wheel" ? (
              <>
                <SpinWheel
                  key={`${listFilter}-${selectedGenres.size}-${runtimeRange[0]}-${runtimeRange[1]}-${wheelNames.length}`}
                  items={wheelNames}
                  onResult={(film) => setResult(film)}
                />
                {result && (
                  <div className="text-center px-6 py-5 rounded-xl bg-card border-2 border-accent/50 max-w-md w-full">
                    <div className="flex items-center justify-center gap-2 mb-2">
                      <Sparkles className="w-5 h-5 text-accent" />
                      <span className="text-xs font-medium text-accent uppercase tracking-wider">
                        You&apos;re watching
                      </span>
                      <Sparkles className="w-5 h-5 text-accent" />
                    </div>
                    <h2 className="text-xl sm:text-2xl font-bold text-foreground">
                      {result}
                    </h2>
                  </div>
                )}
              </>
            ) : (
              <div className="w-full max-w-[500px]">
                <ul className="divide-y divide-border rounded-lg border border-border bg-card overflow-hidden">
                  {wheelFilms.map((film, i) => (
                    <li
                      key={film.slug}
                      className="flex items-center gap-3 px-4 py-2.5 text-sm"
                    >
                      <span className="text-muted text-xs w-6 text-right">
                        {i + 1}
                      </span>
                      <span className="text-foreground">{film.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <div className="text-center py-12 px-4 rounded-lg border border-border bg-card">
              <p className="text-muted text-sm">
                {dataFetched &&
                (selectedGenres.size > 0 ||
                  runtimeRange[0] > runtimeMin ||
                  runtimeRange[1] < runtimeMax)
                  ? "No films match the current filters. Try adjusting them."
                  : listFilter === "mutual"
                    ? 'No mutual films found. Try switching to "All films".'
                    : "No films found on the watchlists."}
              </p>
            </div>
          )}
        </div>
      )}
      {/* Footer */}
      <footer className="mt-auto pt-16 pb-8 w-full max-w-[490px]">
        <hr className="border-border mb-8" />
        <div className="flex flex-col items-start gap-3">
          {/* <a
            href="https://buymeacoffee.com/wglander"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-accent-foreground font-semibold text-sm hover:bg-accent-hover transition-colors"
          >
            <span className="text-lg">☕</span>
            Support this project
          </a> */}
          <p className="text-sm text-muted">
            The github for this project lives{" "}
            <a
              href="https://github.com/WGLander/Watchlist-Roulette"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              here
            </a>
            .
          </p>
          <p className="text-sm text-muted">
            Thank you to{" "}
            <a
              href="https://www.samlearner.com/work"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Sam Learner
            </a>
            , whose letterboxd recommendation{" "}
            <a
              href="https://letterboxd.samlearner.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              project
            </a>{" "}
            I used to scaffold this project.
          </p>
        </div>
      </footer>
    </div>
  );
}
