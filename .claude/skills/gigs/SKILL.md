---
name: gigs
description: Add, complete, and modify gigs in the Valkyrie gig log (kups's game-style task tracker) from Claude Code. Use when the user asks to create/complete/hold/abandon/rename gigs, objectives, or sections, or to review the gig log.
---

# Valkyrie gig management

**Act immediately.** Execute the user's request in the same turn — never ask "ready to run this?" or present a script for approval. The only stop-and-confirm is DELETE (permanent, cascades objectives + links).

The gig log lives in the Valkyrie backend on odin (`127.0.0.1:3001`, loopback-trusted). Manage it over SSH:

```bash
ssh brendon@odin 'curl -s http://127.0.0.1:3001/api/gigs'
# Response shape: {"gigs":[{id,title,category,section,status,tracked,subgigs:[...],links:[...],progress},...]}
# jq: '.gigs[] | select(.title|test("printer";"i")) | .id'

ssh brendon@odin 'curl -s -X POST http://127.0.0.1:3001/api/gigs -H "Content-Type: application/json" -d "{\"title\":\"...\",\"category\":\"side\",\"section\":\"Org C\"}"'
ssh brendon@odin 'curl -s -X PATCH http://127.0.0.1:3001/api/gigs/<id> -H "Content-Type: application/json" -d "{\"status\":\"completed\"}"'
ssh brendon@odin 'curl -s -X DELETE http://127.0.0.1:3001/api/gigs/<id>'
```

- PATCH fields: `title`, `detail`, `category` (`main|side|daily|work`), `section` (string; `""` clears), `status` (`active|completed|failed|on_hold`), `tracked` (bool).
- **Sections** are named groups in the gig list (like client buckets). "add a gig in section X" / "make a section X with gigs A, B" = top-level gigs with `section: "X"` — NOT objectives on another gig. Work gigs group by their Autotask client automatically; section is for everything else.
- Objectives are subgigs: `POST /api/gigs` with `parentId: <gig id>` (no section/category needed); complete one by PATCHing its own id to `status: completed`.
- Links: `POST /api/gigs/<id>/links` `{kind: ticket|email|url, ref, label?}`.

Semantics to respect:
- Always GET the list first to resolve ids by title; never guess ids.
- `work` gigs mirror Autotask tickets (sync every ~10 min): the ticket wins on status/title/notes. Completing a work gig here does NOT close the real ticket — warn the user.
- Tracking auto-follows status (active → tracked); only set `tracked` to override.
- Never edit the `[Autotask] ...` first line of a work gig's detail; the sync owns it.
