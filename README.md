# Maia Human Move Explorer

A password-protected web explorer for the moves a similarly rated human is likely to play. It uses the official [CSSLab Maia-3](https://github.com/CSSLab/maia3) implementation and its 5M checkpoint by default.

## What it does

- Interactive, responsive chessboard with server-validated legal moves
- Complete UCI history retained from the starting position and passed to Maia (up to its eight-position context)
- Validated FEN input, conspicuously labelled **position-only** because earlier history is unknowable
- Independent self/opponent ratings (0–5000), with both defaulting to 1500
- Top-five policy probabilities from Maia's official `score_moves()` path, displayed as SAN
- Click-to-play suggestions, undo, reset, flip, copy FEN, and copy PGN

The probabilities represent human move likelihood, not objective move quality.

## Local development

Python 3.12 and Git are required. Installing the package also installs Maia-3 directly from its official public repository. The first prediction downloads the selected checkpoint from Hugging Face.

```bash
python3.12 -m venv .venv
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

The files under `deploy/` and `scripts/` target Debian/Ubuntu, Python 3.12, systemd and nginx. They deliberately do not automate DNS, TLS, password creation, or firewall changes.

1. Create an unprivileged `maia` system user and `/opt/maia-human-move-explorer`.
2. Clone the repository as a timestamped release and point `current` to it.
3. Run `sudo scripts/install.sh` once and `sudo scripts/update.sh` for atomic updates.
4. Create `/etc/nginx/maia.htpasswd` with `htpasswd`, install `deploy/nginx.conf`, validate with `nginx -t`, and obtain TLS through the existing Certbot workflow.
5. Start the service, verify `/healthz`, then make one authenticated prediction to load the checkpoint before accepting traffic.

The nginx template provides Basic Auth, TLS-only redirect, request limiting, a strict same-origin CSP and `X-Robots-Tag`. Basic Auth is only safe over HTTPS. Keep port 8310 bound to loopback and block it externally. Do not put credentials in Git or environment files in the checkout. Rotate the password if shared more broadly than intended. Logs may contain request timing but the app never logs FENs or credentials itself.

## Licensing and source offer

This service is AGPL-3.0-or-later, matching Maia-3. The deployed UI always links to this public repository. A network deployment must publish the **exact corresponding source** for its running version, including local modifications and deployment/build scripts. Preserve copyright and license notices for upstream Maia-3. Model files are downloaded from the official Hugging Face repositories; confirm their applicable terms with the publisher before any use requiring additional legal certainty.

This repository contains no model weights, secrets, credentials, user data, or paid infrastructure configuration.

