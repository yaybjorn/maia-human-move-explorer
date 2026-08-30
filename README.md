# Maia Human Move Explorer

A public, unlisted web explorer for the moves a similarly rated human is likely to play. It uses the official [CSSLab Maia-3](https://github.com/CSSLab/maia3) implementation and its 5M checkpoint by default, with separate Stockfish 18 best-move analysis for comparison.

Opening Drill ownership, route behavior, and deployment context are documented in [`docs/opening-drill-handoff.md`](docs/opening-drill-handoff.md).

`/portsmouth` is a focused White repertoire trainer built from the approved Portsmouth Gambit pack. Correct moves advance the line, Maia chooses among analyzed Black responses, authored feedback explains mistakes, and Stockfish evaluates the final position.

## What it does

- Interactive, responsive chessboard with server-validated legal moves
- Complete UCI history retained from the starting position and passed to Maia (up to its eight-position context)
- PGN import with nested variations; custom-FEN PGNs are rejected because their earlier history is unknowable
- Clickable move-tree navigation, with new moves added as variations when continuing from history
- Independent self/opponent ratings (0–5000), with both defaulting to 1500
- Top-five policy probabilities from Maia's official `score_moves()` path, displayed as SAN
- Click-to-play suggestions, undo, new game, flip, and variation-preserving PGN export
- Cburnett's high-contrast tournament chess pieces, licensed CC BY-SA 3.0

The probabilities represent human move likelihood, not objective move quality.

## Local development

The repertoire gap checker at `/check` accepts a standard-start PGN and uses
Maia to find probable opponent replies that are not represented as variations
or explicitly named in a position comment. Repertoire side, opponent rating,
and probability threshold are configurable.

The standalone `/spellcheck` route checks PGN comments in British English in
the browser, keeps findings grouped by move history, applies selected fixes to
the original PGN text, and downloads the corrected copy without overwriting the
uploaded file.

Python 3.11 or newer and Git are required. Installing the package also installs a pinned revision of Maia-3 directly from its official public repository. The first prediction downloads the selected checkpoint from Hugging Face.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
uvicorn app.main:app --reload
pytest
ruff check .
```

The model is a lazy singleton. Inference is guarded by one process-local lock, so production must use exactly one Uvicorn worker unless a larger memory/concurrency architecture is deliberately introduced.

## Benchmarking

Run the 5M benchmark on the deployment host before launch:

```bash
python scripts/benchmark.py --model maia3-5m --warmup 3 --runs 20
```

The 23M model is optional and free to test, but needs more disk/RAM:

```bash
python scripts/benchmark.py --model maia3-23m --warmup 3 --runs 20
```

Record cold load, warm median/p95/max and peak RSS. Prefer 5M unless 23M remains comfortably below a one-second p95 under realistic CPU contention and offers a useful quality difference. The script intentionally serializes inference like production; concurrency load should be measured at the HTTP layer if deployment capacity changes.

## Production deployment

The opening trainers are available at `/portsmouth` and `/kilkenny`. Both use the same interactive trainer client and server-side Maia/Stockfish services; their repertoire data remains separate.

The authenticated Course Studio at `/studio` proxies its database and publication API through
the Maia service. Configure `/etc/maia-human-move-explorer.env` on the host (mode `0600`, readable
by root) with:

```text
GINGERGM_STUDIO_API_BASE=https://gingergm-opening-drill-api.fablelabs.workers.dev/v1/studio
STUDIO_PROXY_SECRET=<the matching Worker proxy secret>
# Optional for local/staging hosts; production is allowed by default:
STUDIO_ALLOWED_ORIGINS=https://maia.fablelabs.no
```

The proxy secret is injected server-side and must never appear in browser JavaScript, HTML,
repositories, or logs. The Studio fails closed with HTTP 503 when the secret is absent.

The files under `deploy/` and `scripts/` target Debian/Ubuntu, Python 3.11+, systemd and nginx. They deliberately do not automate DNS, TLS, or firewall changes.

1. Create an unprivileged `maia` system user and `/opt/maia-human-move-explorer`.
2. Clone the repository as a timestamped release and point `current` to it.
3. Run `sudo scripts/install.sh` once and `sudo scripts/update.sh` for atomic updates.
4. Install `deploy/nginx.bootstrap.conf`, obtain the certificate with Certbot's webroot flow, then install `deploy/nginx.conf` and validate with `nginx -t`.
5. Start the service, verify `/healthz`, then make one authenticated prediction to load the checkpoint before accepting traffic.

The nginx template provides a TLS-only redirect, request limiting, a strict same-origin CSP and `X-Robots-Tag: noindex, nofollow, noarchive`. Keep port 8310 bound to loopback and block it externally. Logs may contain request timing but the app never logs FENs itself.

## Licensing and source offer

This service is AGPL-3.0-or-later, matching Maia-3. The deployed UI always links to this public repository. A network deployment must publish the **exact corresponding source** for its running version, including local modifications and deployment/build scripts. Preserve copyright and license notices for upstream Maia-3. Model files are downloaded from the official Hugging Face repositories; confirm their applicable terms with the publisher before any use requiring additional legal certainty.

This repository contains no model weights, secrets, credentials, user data, or paid infrastructure configuration.

The included Cburnett chess-piece SVGs are original, unmodified Wikimedia Commons files licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Source pages are linked from the deployed UI.
