# Oracle OpenCode setup

Maintain the web source on `unified-project-sidebar` in `/home/ubuntu/Documents/GitHub/opencode-web`. Oracle is the only maintained checkout. Studio and the Mini run installed backends; they do not need this source tree.

The frontend is built from this branch (currently based on 2.2.4); the three installed backends run 2.2.4. Frontend and backend versions are separate. The live frontend uses `vite preview` to serve `packages/app/dist`; it is not the hot-reloading dev server.

## Install and build

Use Ubuntu ARM64 as `ubuntu`, Node 24, Bun 1.4.4, Git, Python 3, HAProxy, Certbot with its Cloudflare DNS plugin, and Tailscale. Join the existing personal tailnet and retain its access rules. Oracle must reach Studio and the shared company Mini; the Mini must not gain access to personal systems.

```sh
mkdir -p /home/ubuntu/Documents/GitHub
cd /home/ubuntu/Documents/GitHub
git clone --branch unified-project-sidebar https://github.com/saikrishnabolla/opencode.git opencode-web
cd opencode-web
curl -fsSL https://bun.sh/install | bash -s 'bun-v1.4.4'
mkdir -p /home/ubuntu/.local/share/opencode-web-build/bun-1.4.4
ln -s /home/ubuntu/.bun/bin /home/ubuntu/.local/share/opencode-web-build/bun-1.4.4/bun-linux-aarch64
bash ./install --version 2.2.4 --no-modify-path
mkdir -p /home/ubuntu/.local/bin
ln -s /home/ubuntu/.opencode/bin/opencode /home/ubuntu/.local/bin/opencode
/home/ubuntu/.local/share/opencode-web-build/bun-1.4.4/bun-linux-aarch64/bun install --frozen-lockfile
cd packages/app
/home/ubuntu/.local/share/opencode-web-build/bun-1.4.4/bun-linux-aarch64/bun run build
```

Run builds one at a time when the host has capacity. On an existing install, keep the verified `dist` until a replacement build passes; do not build over the live directory. The commands above describe a fresh installation, not a tested disaster-recovery exercise.

## Private configuration

Keep credentials outside Git. Restore `/home/ubuntu/.config/opencode` and `/home/ubuntu/.local/share/opencode` from a protected backup if retaining provider logins, skills, settings, and sessions. Otherwise configure providers with the installed CLI. The backend reads its private password and CORS list from `~/.config/opencode/service.json`; a replacement password must also be updated in the gateway connections file. Studio and Mini each keep their own backend password in the same relative file.

Set `experimental.background_compaction` to `true` in each host's `~/.config/opencode/opencode.json`. Background summaries cost tokens even when unused. Preserve the rest of each config.

Create `/home/ubuntu/.config/opencode-desk` with mode `0700`. Store `connections.json` there with mode `0600`:

```json
{
  "oracle": {"url": "http://127.0.0.1:49374", "password": "<Oracle backend password>"},
  "studio": {"url": "https://studio.tail580d9e.ts.net", "password": "<Studio backend password>"},
  "mini": {"url": "https://nomi-mac-mini.tail7d939e.ts.net", "password": "<Mini backend password>"}
}
```

Replace placeholders privately; never commit this file. Oracle's backend CORS list is `["https://personal-cloud.tail580d9e.ts.net:8500", "https://desk.saibolla.com"]`. The gateway authenticates upstream requests itself and does not send backend passwords to the browser. There is no separate website password; access depends on private Tailscale routing and its access policy.

Restore `projects.json` beside `connections.json`, at mode `0600`, to retain the shared project list. Without that file the list starts empty. Before upgrading the old deployment, copy its current project selection into this file once; keep legacy files with the rollback backup. The app does not read them or restore default projects.

Adding a project includes it in the shared list. Removing it removes only that entry, preserving its files and chats. Browsers refresh the list on focus and every 30 seconds.

Projects are saved in `projects.json`, not in the source code. Adding a project stores a folder reference, not a clone or file sync. The folder must exist on its selected machine.

## Services and HTTPS

Install the three user-service templates from `script/deploy/oracle` into `~/.config/systemd/user`. Install `app.slice.conf` as `~/.config/systemd/user/app.slice.d/limits.conf` to retain the shared 10 GiB memory ceiling. The backend has no separate memory ceiling. Existing `user.control` drop-ins take precedence; inspect effective values after installation. These templates assume the user, paths, and Bun location above.

```sh
mkdir -p ~/.config/systemd/user/app.slice.d
cp script/deploy/oracle/*.service ~/.config/systemd/user/
cp script/deploy/oracle/app.slice.conf ~/.config/systemd/user/app.slice.d/limits.conf
sudo loginctl enable-linger ubuntu
systemctl --user daemon-reload
systemctl --user enable --now opencode.service opencode-web-preview.service opencode-desk.service
```

Only restart existing services after explicit user authorization. The checkout permits authorized restarts in `packages/app/AGENTS.md`. This setup task does not authorize future restarts.

The backend listens on `127.0.0.1:49374`, the built frontend on `127.0.0.1:49375`, and the gateway on `127.0.0.1:49377`. The gateway service explicitly sets `DESK_AUTH_MODE=tailscale`; no `auth.json` or password-setup route is needed in this mode.

For the domain, restore `/etc/letsencrypt` and the existing `private-domains` renewal hook from a protected server backup. Alternatively issue the `private-desktop` certificate with Certbot's Cloudflare DNS plugin for `desk.saibolla.com` and `os.saibolla.com`, then combine `fullchain.pem` and `privkey.pem` into `/etc/haproxy/certs/private-desktop.pem` with mode `0600`. Keep DNS credentials root-only. The renewal hook must rebuild this combined PEM, validate HAProxy, and reload it after renewal. Full certificate and host recovery instructions live in the personal repository at `cloud/Oracle/SERVER.md`.

Install `script/deploy/oracle/haproxy.cfg` at `/etc/haproxy/haproxy.cfg`, validate with `sudo haproxy -c -f /etc/haproxy/haproxy.cfg`, and enable HAProxy and `certbot.timer`. The template uses Oracle's existing Tailscale IP `100.104.4.120`; update it if the rebuilt node has a different IP. The domain DNS record must resolve to Oracle's Tailscale address in DNS-only mode.

Inspect `tailscale serve status` first and preserve unrelated routes. For a fresh node:

```sh
sudo tailscale serve --bg --tcp=443 tcp://127.0.0.1:9443
sudo tailscale serve --bg --https=8444 http://100.104.4.120:8317
sudo tailscale serve --bg --https=8478 http://127.0.0.1:49374
sudo tailscale serve --bg --https=8500 http://127.0.0.1:49375
```

Port 8444 is the separate CLIProxyAPI service; restore it using the personal repository's proxy guide before enabling that route. Do not enable Funnel or public OCI ingress. Studio and Mini must separately retain their installed backend services and private HTTPS routes.

## Verify and update

```sh
node --test script/opencode-desk-gateway.test.mjs
cd packages/app
/home/ubuntu/.local/share/opencode-web-build/bun-1.4.4/bun-linux-aarch64/bun test --conditions=solid --only-failures --isolate --preload ./happydom.ts ./src/runtime/server/managed.test.ts ./src/runtime/server/registry.test.ts ./src/shell/layout/project-sidebar-catalog.test.ts
/home/ubuntu/.local/share/opencode-web-build/bun-1.4.4/bun-linux-aarch64/bun run typecheck:tsc
```

Check service status, effective `MemoryHigh`/`MemoryMax` on `opencode.service` and `app.slice`, and `tailscale serve status`. From an authorized tailnet device, open `https://desk.saibolla.com`, confirm all three servers respond through `/_desk/server/<id>/api/info`, and verify the shared project list and add/remove controls. Backend `/api/config` should report `background_compaction: true`. Do not publish credentials in verification output.

Commit customizations on `unified-project-sidebar`. Keep the tree clean before an upstream merge; resolve conflicts without dropping gateway, catalog, or restart-policy changes:

```sh
git remote add upstream https://github.com/anomalyco/opencode.git # once, if absent
git fetch upstream dev:refs/remotes/upstream/dev
git switch unified-project-sidebar
git merge upstream/dev
```

Rerun checks and build separately before replacing the live frontend. Update installed backends separately; merging source does not upgrade their binaries. A source commit alone does not deploy the UI or restart the gateway.
