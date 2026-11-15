# FreqBlog autoplay — briefing

**Branch:** `feature/freq-blog`  
**Commit:** `3e11f56` — *feat(autoplay): replace Spotify radio with FreqBlog similar tracks*  
**Docs:** [freqblog.com/#docs](https://freqblog.com/#docs)

## Why

Spotify radio autoplay was replaced with [FreqBlog](https://freqblog.com)’s catalog API. Autoplay now pulls **charted tracks in the seed song’s genre**, not Spotify’s radio endpoint. That keeps recommendations closer to what the listener started with, and it spends **one quota unit per station fill** instead of chasing related artists one call at a time.

## What changed

| Before | After |
|--------|--------|
| Spotify radio / related-artist walk | FreqBlog `GET /similar` |
| Fresh recommendation logic per gap | One buffered “station” reused until empty |
| No external catalog key | `FREQBLOG_API_KEY` required for autoplay |

Core files:

- [`src/services/freqblogClient.js`](src/services/freqblogClient.js) — HTTP client, disk cache, rate-limit cooldown
- [`src/services/freqblog.js`](src/services/freqblog.js) — filtering, station arrange, Spotify match helpers
- [`src/services/autoplay.js`](src/services/autoplay.js) — queue fill, resolve, seed lock
- [`src/config.js`](src/config.js) / [`.env.example`](.env.example) / [`docker-compose.yml`](docker-compose.yml) — config wiring
- Tests: [`test/freqblog.test.js`](test/freqblog.test.js), [`test/autoplay.test.js`](test/autoplay.test.js)

## Runtime flow

```
Queue empty + autoplay ON
        │
        ▼
  Anchor seed = autoplaySeed ?? lastTrack ?? previousTrack
  (must be spotify:track:…)
        │
        ▼
  Drain autoplayBuffer → Spotify search → match ISRC / title+artist
        │
        ├── hit → queue up to 12 tracks (batch)
        │
        └── buffer empty → FreqBlog /similar (once) → refill buffer → resolve again
```

Important behaviors:

1. **Seed stays fixed.** Later autoplay songs do not become a new FreqBlog seed. That stops the station from drifting away from the song the user actually requested.
2. **Batch queue.** Up to **12** resolved tracks are added at once so the player panel can show what’s coming next (panel lists **4** upcoming).
3. **Manual queue wins.** If something is already playing or queued by hand when the batch is ready, candidates are pushed back into the buffer instead of being inserted.
4. **Misses skip, Spotify errors pause.** A candidate that doesn’t resolve is dropped; a Spotify lookup failure leaves the rest of the buffer alone so another FreqBlog call is not wasted.

## FreqBlog request shape

One call = one monthly quota unit (free plan: **1,000 / month**):

```
GET https://api.freqblog.com/similar
  ?limit=50
  &cross_genre=strict
  &exclude_same_artist=false
  &charted=true
  &min_chart_peak=40
  &isrc=…          # preferred when known
  # or
  &track=…&artist=…  # primary artist only (Spotify may list many)
```

Header: `X-Api-Key: <FREQBLOG_API_KEY>`  
Timeout: **45s** (a 50-track walk can be slow).

### Post-filters (local)

Even with `cross_genre=strict`, FreqBlog groups some families (e.g. hip-hop / funk / R&B). Local logic tightens that:

| Constant | Value | Role |
|----------|-------|------|
| `MIN_CHART_PEAK` | `40` | Drop weak / scrape-level chart peaks (`chart_peak` 1–100, 100 = #1) |
| `SCORE_WINDOW` | `0.02` | Keep only neighbors close to the best similarity score |
| Genre equality | exact normalized genre | Drop `cross` / `compatible` rows and off-genre tracks |
| Station arrange | ~1 seed-artist song per 3 others | Related artists lead; seed artist does not monopolize |
| Artist round-robin | one song per artist before repeats | Spread the station |

Cache / session marker: `similar-charted-close` (`PLAYLIST_CACHE` / `AUTOPLAY_QUERY`). Older harmonic `/radio` buffers are ignored on restore.

## Caching & durability

| Layer | Where | Notes |
|-------|--------|--------|
| Memory + disk | `freqblog-radio.json` (next to session data; override with `FREQBLOG_CACHE_PATH`) | Keyed by `similar-charted-close:isrc:…` or `…:name:artist\|title`; keeps last **80** playlists |
| Session | `sessions.json` | Persists `autoplayBuffer`, `autoplayFetchedKeys`, `autoplaySeed`, `autoplayQuery` |
| Resolve cache | in-process `WeakMap` | Avoids re-searching the same FreqBlog candidate against Spotify |

404 / empty results are remembered as **misses** so the same seed is not re-hit.  
**401** → cool down **6 hours**. **429** → cool down from `Retry-After` (default 60s).

## Config

| Env | Default | Purpose |
|-----|---------|---------|
| `FREQBLOG_API_KEY` | empty | Required; empty → autoplay stays quiet |
| `FREQBLOG_API_URL` | `https://api.freqblog.com` | Override API host |
| `FREQBLOG_CACHE_PATH` | `<data dir>/freqblog-radio.json` | Disk playlist cache |

Compose passes `FREQBLOG_API_KEY` into the bot service. Toggle per guild with `/autoplay` or the panel button (default **ON** once a key is set).

## Ops checklist

- [ ] Set `FREQBLOG_API_KEY` in `.env` (and redeploy Compose if used)
- [ ] Confirm autoplay works after a Spotify track finishes with an empty queue
- [ ] Confirm panel shows upcoming autoplay tracks
- [ ] Confirm manual `/play` still preempts the autoplay batch
- [ ] Watch logs for `FreqBlog similar for "…" returned N tracks` vs cache reuse
- [ ] If autoplay is silent: missing key, cooldown after 401/429, or non-Spotify seed

## Quota tip

Prefer letting the buffer drain. Each new seed (or exhausted cache miss) costs another call. The design already locks the seed and caches on disk so restarts do not burn the monthly allowance for the same song.
