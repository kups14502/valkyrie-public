# Valkyrie rename: status

Completed 2026-07-15 (code + infra):

- GitHub repo renamed to `kups14502/valkyrie` (old URLs redirect; server remote updated).
- API hostname `valkyrie-api.brendonkupsch.com` live via Cloudflare Tunnel; `master-control-api.brendonkupsch.com` and `api.brendonkupsch.com` kept as aliases so installed apps keep updating.
- Server directory renamed to `/home/brendon/valkyrie`; all code paths updated; backend rebuilt.
- systemd units renamed: `valkyrie-api.service`, `cloudflared-valkyrie.service` (old units removed).
- Samba/bifrost bind mount now exports `valkyrie` (Windows path: `B:\valkyrie`).
- Tauri updater signing keys renamed to `~/.tauri/valkyrie-updater.{key,pw}`; release scripts updated.
- Desktop release v0.3.1 published from the renamed repo; updater manifest verified on both hostnames.

## Remaining (Cloudflare dashboard, no API token on server)

1. **Pages custom domain**: Cloudflare dashboard, Workers and Pages, project `master-control`, Custom domains, add `valkyrie.brendonkupsch.com`. Code (CORS, auth, launcher, `_headers`) already accepts it. Keep `master-control.brendonkupsch.com` attached during transition.
2. **Pages Git integration**: after a repo rename, Pages sometimes stops auto-building. Check the project's latest deployment; if stale, Settings, Builds and deployments, reconnect the `kups14502/valkyrie` repo.
3. **Cloudflare Access**: if the Access application is scoped to the old hostnames, add `valkyrie-api.brendonkupsch.com` (and `valkyrie.brendonkupsch.com`) to it in Zero Trust, Access, Applications. The backend's own token auth protects the API regardless.
4. **Pages project name** (optional, cosmetic): projects cannot be renamed; recreating as `valkyrie` changes the `*.pages.dev` preview domain, which is referenced in `backend/src/index.ts` and `backend/src/middleware/auth.ts` preview regexes. Skip unless it bothers you.

## Deliberately kept

- **Tauri bundle identifier `com.brendonkupsch.mastercontrol`**: changing it makes every installed desktop/mobile app treat the next build as a brand-new app (orphaned installs, lost settings). Only change if you accept reinstalling on every device.
- Old hostnames in `middleware/auth.ts` / `ALLOWED_ORIGINS` / tunnel ingress: remove them once every device uses the new URLs and the last pre-0.3.1 app has updated.
