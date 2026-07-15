# Valkyrie rename: remaining infrastructure

All code-level names are now Valkyrie (package names, Tauri crate, artifact names, localStorage keys with legacy fallbacks, MCP client name, user-agent strings, launcher id). What remains is infrastructure whose identifiers live outside this repo. Each item below breaks something if renamed in code alone, so rename the infrastructure first, then flip the matching code reference in the same deploy.

## 1. GitHub repo (`kups14502/master-control`)

- `gh repo rename valkyrie --repo kups14502/master-control`
- GitHub redirects old clone/release URLs, but Cloudflare Pages Git integration sometimes breaks on rename. Check the Pages project after renaming and reconnect the repo if builds stop.
- Then update: `scripts/release.sh` (REPO), `backend/src/routes/updates.ts` (REPO const), `frontend/src-tauri/Cargo.toml` (repository), local git remotes.

## 2. DNS hostnames (Cloudflare)

- `master-control.brendonkupsch.com` (frontend) and `master-control-api.brendonkupsch.com` (API tunnel). Add `valkyrie.brendonkupsch.com` and `valkyrie-api.brendonkupsch.com` as new records/tunnel ingress first, keep the old ones as aliases during transition.
- Then update: `frontend/.env.production`, both GitHub workflow files (VITE_API_URL), `frontend/public/_headers`, `backend/.env` + `.env.example` (ALLOWED_ORIGINS), `backend/src/middleware/auth.ts` (trusted origins/hosts), `backend/src/routes/updates.ts` (PUBLIC_BASE), `backend/src/routes/launcher.ts` (url), `frontend/src-tauri/tauri.conf.json` (updater endpoint). Keep old hostnames accepted in auth.ts until all installed apps have updated, because shipped desktop apps poll the old updater URL.

## 3. Cloudflare Pages project (`master-control` / `master-control-72u.pages.dev`)

- Pages projects cannot be renamed cleanly; create a `valkyrie` project pointing at the same repo/branch or accept the old project name.
- Then update the preview-origin regexes in `backend/src/index.ts` and `backend/src/middleware/auth.ts`.

## 4. Server directory (`/home/brendon/master-control`)

- Renaming the directory breaks the running service, the projects/activity feeds, ccusage path, alerts state path, and this share (B:\master-control). If ever done: stop service, `mv`, update `backend/src/alerts.ts`, `routes/activity.ts`, `routes/projects.ts`, `routes/aiUsage.ts` (CCUSAGE_BIN), `backend/src/auth/store.ts` and `backend/src/quests/store.ts` (DATA_DIR), the email-assistant QUESTS_DB path, systemd unit WorkingDirectory, remount share.

## 5. systemd unit (`master-control-api.service`)

- On the server: copy the unit to `valkyrie-api.service`, `systemctl --user disable --now master-control-api && systemctl --user enable --now valkyrie-api` (or system scope if applicable).
- Then update `backend/src/routes/launcher.ts` (owner field).

## 6. Tauri bundle identifier (`com.brendonkupsch.mastercontrol`)

- Deliberately NOT renamed. Changing it makes installed desktop/mobile apps treat the next update as a different app (orphaned installs, duplicate registry entries). Only change it if you accept a clean reinstall on every device.

## 7. Tauri updater signing key files

- `scripts/release.sh` defaults to `$HOME/.tauri/mc-updater.key` / `mc-updater.pw`. If you want those renamed, rename the files where releases run and update the two defaults in release.sh together.
