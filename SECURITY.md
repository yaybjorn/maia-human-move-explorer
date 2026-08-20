# Security

Report vulnerabilities privately to `oddbjorn@fablelabs.no`; do not open a public issue for an exploitable flaw.

The intended deployment is private behind HTTPS Basic Auth. Keep the inference port loopback-only, use the nginx rate limit, retain `noindex` headers, and never commit the htpasswd file. FEN and move history are transient request data and are not persisted. Upgrade Python, PyTorch, Maia-3 and web dependencies deliberately after testing.

