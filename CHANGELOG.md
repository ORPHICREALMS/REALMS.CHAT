# Changelog

## 1.0.2 — Flat repository layout

- Moved `index.html`, `app.js`, and `style.css` to the repository root so every project file can be uploaded together without any nested folders.
- Updated the server to serve the three browser files explicitly from the root. The server no longer relies on a `public/` directory.
- Updated the package check script and version metadata for the root-level `app.js`.
- Kept the no-account, no-database guest architecture from 1.0.1.

## 1.0.1 — Guest-first correction

- Removed account registration, login, passwords, logout, bcrypt, and session storage.
- Removed PostgreSQL and all database wiring from `render.yaml`.
- Render Blueprint creates one Free web service only.
- Added anonymous signed guest identities and online-player discovery for DMs.
- Each DM remains a separate channel keyed by the two guests' browser identities.
- Added local browser cache for recent messages and DM shortcuts.
- Added DM notifications so a recipient learns about a new conversation while online.
- Made temporary, in-memory server history explicit in the README and Options dialog.
