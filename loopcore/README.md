# Loopcore

Industrial symbiosis for the UAE — a live savings calculator, an animated network map, and a waste-stream matcher that proposes the loops worth chasing first.

**Preview:** https://loopcore-2m11hm-preview.freebuff.site

## Run it

No dependencies. No build step. Node 18+ only if you want the AI matcher.

```bash
node server.js          # http://localhost:3000
```

`server.js` serves `public/` and proxies `/api/match`.

You can also just open `public/index.html` in a browser. Everything except the AI matcher works from disk, and the matcher falls back to its built-in library.

## The AI matcher

The key never reaches the browser — the page calls `/api/match`, the server calls the model.

```bash
ANTHROPIC_API_KEY=sk-... node server.js
```

Environment variables:

| name | default | what |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | enables the live matcher |
| `LOOPCORE_MODEL` | `claude-sonnet-4-5` | override the model |
| `PORT` | `3001` | HTTP port |

With no key set, `/api/match` answers `501` and the page renders from the `LIBRARY` array in `public/index.html`. That is the demo-safe path: if the wifi dies on stage, the screen still fills.

## Deploy

`worker.js` + `manifest.json` are the edge version of the same contract (Cloudflare Workers). The assets directory is `public/`, so the file you edit in development is the file that ships. Set `ANTHROPIC_API_KEY` as a Worker secret.

## Where the numbers come from

Four constants, at the top of the script block in `public/index.html`, and repeated in the page's **Assumptions** section:

| constant | value | meaning |
|---|---|---|
| `ENERGY_PRICE` | 250 AED/MWh | marginal cost of heat avoided, not the retail tariff |
| `RECOVERY` | 60% | share of an identified stream a real loop reuses |
| `CO2_PER_MWH` | 0.4 t | emission factor per avoided MWh |
| `DIVERSION` | 50% | share of disposal cost that disappears |

They are illustrative and deliberately conservative. Before a demo, replace them with figures from one real site — and be able to say where each came from.

## Layout

```
public/index.html   the whole site: markup, styles, front-end JS, the plant map and the offline library
server.js           dev server + AI proxy (no dependencies)
worker.js           the same endpoint on Cloudflare Workers
manifest.json       deploy manifest for worker.js + public/
```

The map is generated in JS from the `NODES` and `LINKS` arrays — add a plant there and it appears on the ring.

## Ideas that were deliberately left out

- Real plant data: every stream on the map is illustrative.
- Persistence: nothing is stored, no accounts, no database.
- The matcher's cost figures are model output, not quotations.
