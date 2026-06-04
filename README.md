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
- VITE_API_URL: backend base URL for the frontend, set this to your Render URL in production
- FRONTEND_ORIGIN: public frontend URL, set this to your Vercel URL in production
- SESSION_COOKIE_SAME_SITE: cookie policy for auth sessions, use None for Vercel plus Render deployments
- SESSION_COOKIE_SECURE: set true for HTTPS production deployments
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

## Deploying Frontend On Vercel And Backend On Render

1. Deploy the frontend to Vercel from this repo root.
2. Set `VITE_API_URL` in Vercel to your Render backend URL, for example `https://chatify-api.onrender.com`.
3. Deploy the backend to Render with start command `npm run start`.
4. You can use the included `render.yaml` as a Render blueprint for the backend service.
5. Set these Render environment variables:
   - `FRONTEND_ORIGIN` to your Vercel URL, for example `https://chatify.vercel.app`
   - `SESSION_COOKIE_SAME_SITE=None`
   - `SESSION_COOKIE_SECURE=true`
   - `GOOGLE_REDIRECT_URI` to `https://your-render-service.onrender.com/api/auth/google/callback`
6. If you use Google OAuth, add both the Vercel frontend origin and the Render callback URL in Google Cloud Console.

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
