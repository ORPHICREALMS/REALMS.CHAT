# Orphic Communicator — Guest Beta 1.0.2

A compact, browser-based chat hub for Orphic Realms, in the pale orchid / pixel-wonderland style.

## Deliberate scope

- **No accounts, registration, passwords, or login page.** Visitors receive a signed anonymous guest identity in an HttpOnly browser cookie. Their display name can be changed in Options.
- **No database and no required paid tier.** The Render Blueprint creates one Free web service only. PostgreSQL, persistent disks, hosted identity providers, and external auth services are not used.
- Realms-wide chat, selectable game rooms, a separate DM per guest, optional API Buddy, and WebRTC audio/video signaling are included.
- The Buddy API key is held only in the current page's memory. It is not saved to browser storage or the database. When Buddy is used, the key is sent to this service over HTTPS and forwarded to the configured allowed API host. Only configure a provider you trust; that provider may charge for its own API usage. Buddy is optional.
- Existing games do not need to be rewritten. Players can use this site directly; game integrations can be added later if desired.

## IMPORTANT: every project file is at the repository root

**There are no project subfolders in this ZIP.** Upload the individual files together into the root of a new, empty GitHub repository. Do not create a `public/` or `orphic-communicator/` folder.

The root should contain:

- `index.html`
- `app.js`
- `style.css`
- `server.js`
- `package.json`
- `render.yaml`
- `README.md`
- `CHANGELOG.md`
- `.gitignore`
- `.env.example`

The server has been updated to serve `/`, `/app.js`, and `/style.css` from those root-level files. It serves only those browser assets explicitly rather than exposing the entire repository as public static files. The `npm run check` script also checks the root-level `app.js` path.

### Upload the files to GitHub

1. Download and unzip this package on your computer.
2. Open the new, empty GitHub repository in your browser.
3. Choose **Add file → Upload files**.
4. Open the extracted folder on your computer and select all ten files, including the dotfiles `.gitignore` and `.env.example`, then drag them into the GitHub upload area. Select the files themselves, not the containing folder.
5. Commit the upload. The repository's first page should show `server.js`, `index.html`, `app.js`, `style.css`, `package.json`, and `render.yaml` directly in the file list—not inside another directory.

## Deploy on Render without adding a database

1. In Render, choose **New → Blueprint** and connect this repository.
2. Render reads the root-level `render.yaml` and creates one Free Node web service. It generates `ORPHIC_GUEST_SECRET` automatically. There is no database resource in the Blueprint.
3. Wait for deployment, then open the service's `onrender.com` URL.
4. Open the site in a second browser profile/private window or ask a friend to open it to test messages. Each separate browser gets its own guest identity.

The first request after a free service spins down may take a while to start. The no-cost configuration is intended for testing, not guaranteed always-on use.

## Local development

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env
npm run check
npm start
```

Open `http://localhost:10000`. No database configuration is required. If `ORPHIC_GUEST_SECRET` is absent in local development, a temporary secret is generated when the server starts; guest cookies may therefore roll into a new identity after a restart.

## API Buddy

Buddy is optional and off until a visitor configures an endpoint, model, and key in Options. By default, the server allows the `api.openai.com` hostname. To allow another HTTPS-compatible chat-completions provider, add its exact hostname to `BUDDY_ALLOWED_HOSTS` in Render's environment settings, comma-separated. This allowlist helps stop an unauthenticated server from making requests to arbitrary internal endpoints.

There is no paid Communicator subscription and no mandatory AI provider key. External AI providers may charge for API usage if you choose to use Buddy.

## Audio / video calling

One-to-one WebRTC calls use Socket.IO signaling on this same web service. Camera and microphone access require HTTPS (provided by Render) and browser permission. The default configuration uses a public STUN server. Some networks require a TURN relay, which is not included in this package; calls on those networks may fail until a relay is configured.

## Free-beta limitations and safety

- Live messages and server-side conversation buffers are stored **in server memory**, up to 160 recent messages per conversation. Browser-local caches can preserve messages a visitor has already seen, but they are not a shared durable archive.
- Server restarts, deploys, or spin-downs can clear guest presence, active calls, and shared message buffers. Browser-local history only exists in that browser and does not follow the visitor to another device.
- Guest names are not verified identities. DMs are separated by browser guest IDs and signed HttpOnly cookies, but without account recovery or external identity verification this is not a high-security messaging product.
- WebRTC uses STUN by default. A TURN relay may be required on restrictive networks.
- Never commit real API keys or secrets. Render generates `ORPHIC_GUEST_SECRET`; Buddy keys are entered only for the current page session.
