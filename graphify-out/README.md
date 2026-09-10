# Graphify knowledge graph — Expense Tool V1

Map of this repo (code + docs) for AI agents and teammates. Built with `graphifyy`.

- `graph.json` — 498 nodes / 1205 edges / 19 communities. Query target.
- `graph.html` — interactive view (vis-network vendored in `vendor/` so it works offline).
- `GRAPH_REPORT.md` — readable digest.
- `cache/`, `YYYY-MM-DD/` — transient, gitignored.

## View
`cd graphify-out && python3 -m http.server 8899` → http://127.0.0.1:8899/graph.html
(or open graph.html directly). If a `graphify` rebuild re-points it at unpkg,
re-vendor: `curl -sSL -o graphify-out/vendor/vis-network.min.js https://cdn.jsdelivr.net/npm/vis-network@9.1.6/standalone/umd/vis-network.min.js` then swap the `<script src>` in graph.html.

## Refresh
`graphify update .` (AST only, free). Full doc<->code re-link:
`export DEEPSEEK_API_KEY=... && graphify extract . --backend deepseek && graphify cluster-only . --backend deepseek`

## Query
`graphify query "how are bank statements parsed and matched to invoices?"`
`graphify explain "paymentMatching"` · `graphify god-nodes`

## Relationship to the Operation Center (costing-tool)
`netlify/edge-functions/sync-operation-center.js` here calls the Operation
Center's `/api/finance-po-sync`, `/api/uc`, `/api/erp` over HTTP. That's an
architectural link, not a code edge — a merged graph unions the two repos but
won't draw a line between the two sync endpoints (no shared symbol; it's an
HTTP boundary).
