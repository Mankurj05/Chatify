# Chatify

Chatify is a full-stack one-to-one chat app with real-time messaging, friend-only conversations, temporary disappearing messages, presence visibility controls, private chat pinning, and Google OAuth login.

## Features

- Friend request and accept/reject workflow
- One-to-one chat only between accepted friends
- Permanent and temporary message modes
- Temporary messages with per-line timers and auto-expiry
- Seen/unseen message status
- Online/offline and last-seen visibility controls
- Message actions: copy, forward, delete (hold-to-confirm)
- Delete full chat history
- Private chat toggle with separate tab
- Unseen message badges on chats and tabs
- Local auth (email/password) and Google OAuth

## Tech Stack

- Frontend: React 19, TypeScript, Vite
- Backend: Express, Socket.IO, TypeScript
- Storage: JSON file at data/chat-store.json

## Project Structure

- src: frontend app
- server: backend API and socket server
- shared: shared TypeScript types
- data: local persisted store file

## Prerequisites

- Node.js 18+
- npm 9+

## Local Setup

1. Install dependencies:

   npm install

2. Create local environment file:

   Copy .env.example to .env and fill values.

3. Start development server:

   npm run dev

4. Open app:

   http://localhost:5173

## Environment Variables

Use these in .env (see .env.example):

- PORT: backend port, default 3001
- VITE_PORT: frontend port hint used by OAuth return fallback, default 5173
- GOOGLE_CLIENT_ID: Google OAuth client id
- GOOGLE_CLIENT_SECRET: Google OAuth client secret
- GOOGLE_REDIRECT_URI: Google callback URL (default http://localhost:3001/api/auth/google/callback)

## Google OAuth Setup

In Google Cloud Console (OAuth 2.0 Client ID):

- Authorized redirect URI:
  http://localhost:3001/api/auth/google/callback
- Authorized JavaScript origin:
  http://localhost:5173

After setting env vars, restart the app and click Continue with Google on the auth screen.

## Scripts

- npm run dev: run frontend and backend in watch mode
- npm run build: build frontend to dist/client
- npm run start: run backend server

## Notes for GitHub Push

- .env and all .env.* files are ignored
- Keep secrets out of commits
- data/chat-store.json is ignored (local runtime data)

## Troubleshooting

- If you see EADDRINUSE on port 3001 or 5173, stop old processes and rerun npm run dev.
- If Google login fails on token exchange, verify GOOGLE_CLIENT_SECRET and redirect URI values.
- If Google login returns to wrong host, confirm frontend runs on http://localhost:5173 and VITE_PORT is set correctly.
