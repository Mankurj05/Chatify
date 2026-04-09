import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Server } from 'socket.io';
import { randomUUID } from 'node:crypto';
import type {
  AuthCredentials,
  AuthenticatedUser,
  ChatMessage,
  ConversationSnapshot,
  FriendRequest,
  OpenConversationPayload,
  RegisterPayload,
  SendMessagePayload,
  StoredUser,
} from '../shared/types';
import {
  clearSessionCookie,
  createSessionExpiry,
  createSessionToken,
  getSessionTokenFromCookie,
  hashPassword,
  isEmailLike,
  normalizeDisplayName,
  normalizeEmail,
  parseCookieHeader,
  serializeSessionCookie,
  verifyPassword,
} from './auth';
import {
  addFriendship,
  areFriends,
  createFriendRequest,
  deleteSession,
  findPendingRequestBetween,
  findUserByEmail,
  findUserByGoogleId,
  findUserByHandle,
  findUserById,
  getConversationMessages,
  getFriendIds,
  getPrivateChatIds,
  getSession,
  isPrivateChat,
  listAllRequestsForUser,
  listFriendRequestsForUser,
  listMessages,
  listUsers,
  loadStore,
  removeMessage,
  removeConversationMessages,
  respondToFriendRequest,
  searchUsersByEmailOrHandle,
  togglePrivateChat,
  upsertMessage,
  upsertSession,
  upsertUser,
} from './store';

const port = Number(process.env.PORT ?? 3001);
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI ?? `http://localhost:${port}/api/auth/google/callback`;
const googleStateCookieName = 'chatify_google_oauth_state';
const googleReturnCookieName = 'chatify_google_oauth_return';
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const clientDist = path.join(process.cwd(), 'dist', 'client');
const hasClientBuild = existsSync(path.join(clientDist, 'index.html'));

if (hasClientBuild) {
  app.use(express.static(clientDist));
}

const onlineSocketsByUser = new Map<string, Set<string>>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function conversationIdFor(userA: string, userB: string) {
  return [userA, userB].sort((left, right) => left.localeCompare(right)).join(':');
}

function userRoom(userId: string) {
  return `user:${userId}`;
}

function onlineUserIds() {
  return [...onlineSocketsByUser.entries()]
    .filter(([, sockets]) => sockets.size > 0)
    .map(([userId]) => userId)
    .sort((left, right) => left.localeCompare(right));
}

function toPublicUser(user: StoredUser): AuthenticatedUser {
  return {
    id: user.id,
    handle: user.handle,
    email: user.email,
    displayName: user.displayName,
    provider: user.provider,
    createdAt: user.createdAt,
    sharePresence: user.sharePresence,
    presenceState: user.presenceState,
    lastSeenAt: user.lastSeenAt,
  };
}

function isUserOnlineForFriends(user: StoredUser) {
  return user.sharePresence && user.presenceState === 'online' && (onlineSocketsByUser.get(user.id)?.size ?? 0) > 0;
}

function getPresenceForFriend(viewerId: string, friend: StoredUser) {
  if (!areFriends(viewerId, friend.id)) {
    return { isOnline: false, lastSeenAt: null as number | null, isVisible: false };
  }

  if (!friend.sharePresence) {
    return { isOnline: false, lastSeenAt: null as number | null, isVisible: false };
  }

  const isOnline = isUserOnlineForFriends(friend);
  return { isOnline, lastSeenAt: isOnline ? friend.lastSeenAt : friend.lastSeenAt, isVisible: true };
}

async function updateUserPresenceMeta(userId: string, patch: Partial<Pick<StoredUser, 'presenceState' | 'sharePresence' | 'lastSeenAt'>>) {
  const user = findUserById(userId);

  if (!user) {
    return;
  }

  await upsertUser({ ...user, ...patch });
}

function authUserFromCookie(cookieHeader: string | undefined) {
  const token = getSessionTokenFromCookie(cookieHeader);

  if (!token) {
    return null;
  }

  const session = getSession(token);
  if (!session) {
    return null;
  }

  const user = findUserById(session.userId);
  return user ? toPublicUser(user) : null;
}

function authUserFromRequest(request: express.Request) {
  return authUserFromCookie(request.headers.cookie);
}

function requireAuth(request: express.Request, response: express.Response) {
  const user = authUserFromRequest(request);

  if (!user) {
    response.status(401).json({ message: 'Not signed in' });
    return null;
  }

  return user;
}

function sanitizeHandle(seed: string) {
  const letters = seed.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (letters || 'user').slice(0, 12);
}

function isGoogleAuthConfigured() {
  return Boolean(googleClientId && googleClientSecret);
}

function serializeGoogleStateCookie(state: string) {
  return `${googleStateCookieName}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`;
}

function clearGoogleStateCookie() {
  return `${googleStateCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function serializeGoogleReturnCookie(returnTo: string) {
  return `${googleReturnCookieName}=${encodeURIComponent(returnTo)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`;
}

function clearGoogleReturnCookie() {
  return `${googleReturnCookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function normalizeReturnOrigin(input: string | undefined, fallback: string) {
  if (!input) {
    return fallback;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return fallback;
    }

    return parsed.origin;
  } catch {
    return fallback;
  }
}

function buildGoogleAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'online',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function buildUniqueHandle(displayName: string) {
  const base = sanitizeHandle(displayName);

  for (let i = 0; i < 10000; i += 1) {
    const suffix = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    const handle = `${base}${suffix}`;

    if (!findUserByHandle(handle)) {
      return handle;
    }
  }

  return `${base}${Date.now().toString().slice(-6)}`;
}

function calculateLineCount(body: string) {
  return Math.max(1, body.split(/\r?\n/).length);
}

function calculateDelaySeconds(lineCount: number, baseSecondsPerLine: number) {
  return Math.max(1, lineCount) * Math.max(1, Math.round(baseSecondsPerLine));
}

function clearExpiryTimer(messageId: string) {
  const timer = expiryTimers.get(messageId);

  if (timer) {
    clearTimeout(timer);
    expiryTimers.delete(messageId);
  }
}

async function emitMessageUpserted(message: ChatMessage) {
  const conversationId = conversationIdFor(message.senderId, message.recipientId);
  io.to(conversationId).emit('message:upserted', message);
  io.to(userRoom(message.senderId)).emit('message:upserted', message);
  io.to(userRoom(message.recipientId)).emit('message:upserted', message);
}

async function emitMessageRemoved(message: ChatMessage) {
  const conversationId = conversationIdFor(message.senderId, message.recipientId);
  const payload = { messageId: message.id, conversationId };
  io.to(conversationId).emit('message:removed', payload);
  io.to(userRoom(message.senderId)).emit('message:removed', payload);
  io.to(userRoom(message.recipientId)).emit('message:removed', payload);
}

function scheduleTemporaryExpiry(message: ChatMessage) {
  if (message.mode !== 'temporary' || !message.expiresForRecipientAt) {
    return;
  }

  clearExpiryTimer(message.id);

  const delayMs = Math.max(0, message.expiresForRecipientAt - Date.now());

  expiryTimers.set(
    message.id,
    setTimeout(async () => {
      clearExpiryTimer(message.id);
      await removeMessage(message.id);
      await emitMessageRemoved(message);
    }, delayMs)
  );
}

async function startTemporaryTimerIfNeeded(message: ChatMessage, openingUserId: string) {
  if (message.mode !== 'temporary' || message.recipientId !== openingUserId) {
    return message;
  }

  if (message.recipientOpenedAt && message.expiresForRecipientAt) {
    scheduleTemporaryExpiry(message);
    return message;
  }

  const now = Date.now();
  const expiresAt = now + message.delaySeconds * 1000;
  const next: ChatMessage = {
    ...message,
    status: 'visible',
    recipientOpenedAt: now,
    visibleToRecipientAt: now,
    expiresForRecipientAt: expiresAt,
    seenByRecipientAt: now,
  };

  await upsertMessage(next);
  await emitMessageUpserted(next);
  scheduleTemporaryExpiry(next);

  return next;
}

async function buildConversationSnapshot(viewer: AuthenticatedUser, peer: AuthenticatedUser): Promise<ConversationSnapshot> {
  const messages = getConversationMessages(viewer.id, peer.id);
  const nextMessages: ChatMessage[] = [];

  for (const message of messages) {
    nextMessages.push(await startTemporaryTimerIfNeeded(message, viewer.id));
  }

  return {
    conversationId: conversationIdFor(viewer.id, peer.id),
    peer,
    messages: nextMessages,
    onlineUserIds: onlineUserIds(),
    updatedAt: Date.now(),
  };
}

async function markConversationSeen(viewerId: string, peerId: string) {
  const messages = getConversationMessages(viewerId, peerId);

  for (const message of messages) {
    if (message.senderId !== peerId || message.recipientId !== viewerId || message.seenByRecipientAt) {
      continue;
    }

    const next: ChatMessage = {
      ...message,
      seenByRecipientAt: Date.now(),
    };

    await upsertMessage(next);
    await emitMessageUpserted(next);
  }
}

function requestWithUsers(request: FriendRequest, currentUserId: string) {
  const from = findUserById(request.fromUserId);
  const to = findUserById(request.toUserId);

  return {
    ...request,
    direction: request.fromUserId === currentUserId ? 'outgoing' : 'incoming',
    fromUser: from ? toPublicUser(from) : null,
    toUser: to ? toPublicUser(to) : null,
  };
}

function emitPresence() {
  io.emit('users:presence', { onlineUserIds: onlineUserIds() });
}

function emitFriendGraphUpdate(userIds: string[]) {
  for (const userId of [...new Set(userIds)]) {
    io.to(userRoom(userId)).emit('friends:updated', { userId });
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, users: listUsers().length, messages: listMessages().length });
});

app.get('/api/auth/me', (request, response) => {
  const user = authUserFromRequest(request);

  if (!user) {
    response.status(401).json({ message: 'Not signed in' });
    return;
  }

  response.json({ user });
});

app.get('/api/auth/providers', (_request, response) => {
  const supported = ['local'];
  if (isGoogleAuthConfigured()) {
    supported.push('google');
  }

  response.json({ supported });
});

app.get('/api/auth/google/start', (request, response) => {
  if (!isGoogleAuthConfigured()) {
    response.status(503).json({ message: 'Google auth is not configured on the server.' });
    return;
  }

  const state = randomUUID();
  const fallbackOrigin = `http://localhost:${Number(process.env.VITE_PORT ?? 5173)}`;
  const requestedReturn = String(request.query.returnTo ?? request.headers.origin ?? '');
  const returnOrigin = normalizeReturnOrigin(requestedReturn, fallbackOrigin);

  response.setHeader('Set-Cookie', [serializeGoogleStateCookie(state), serializeGoogleReturnCookie(returnOrigin)]);
  response.redirect(buildGoogleAuthUrl(state));
});

app.get('/api/auth/google/callback', async (request, response) => {
  if (!isGoogleAuthConfigured()) {
    response.redirect('/?authError=google_not_configured');
    return;
  }

  const code = String(request.query.code ?? '');
  const returnedState = String(request.query.state ?? '');
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieState = cookies.get(googleStateCookieName) ?? '';
  const returnOrigin = normalizeReturnOrigin(
    cookies.get(googleReturnCookieName),
    `http://localhost:${Number(process.env.VITE_PORT ?? 5173)}`
  );

  response.setHeader('Set-Cookie', [clearGoogleStateCookie(), clearGoogleReturnCookie()]);

  if (!code || !returnedState || !cookieState || returnedState !== cookieState) {
    response.redirect(`${returnOrigin}/?authError=google_state_mismatch`);
    return;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: googleRedirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    if (!tokenResponse.ok) {
      response.redirect(`${returnOrigin}/?authError=google_token_exchange_failed`);
      return;
    }

    const tokenData = (await tokenResponse.json()) as { id_token?: string };
    const idToken = tokenData.id_token ?? '';

    if (!idToken) {
      response.redirect(`${returnOrigin}/?authError=google_missing_id_token`);
      return;
    }

    const profileResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);

    if (!profileResponse.ok) {
      response.redirect(`${returnOrigin}/?authError=google_invalid_token`);
      return;
    }

    const profile = (await profileResponse.json()) as {
      aud?: string;
      sub?: string;
      email?: string;
      email_verified?: string;
      name?: string;
    };

    const googleId = profile.sub ?? '';
    const email = normalizeEmail(profile.email ?? '');
    const emailVerified = profile.email_verified === 'true';
    const audienceOk = profile.aud === googleClientId;

    if (!googleId || !email || !emailVerified || !audienceOk) {
      response.redirect(`${returnOrigin}/?authError=google_profile_invalid`);
      return;
    }

    const displayName = normalizeDisplayName(profile.name ?? email.split('@')[0] ?? 'Google User');
    const existingByGoogle = findUserByGoogleId(googleId);
    const existingByEmail = findUserByEmail(email);

    if (existingByGoogle && existingByEmail && existingByGoogle.id !== existingByEmail.id) {
      response.redirect(`${returnOrigin}/?authError=google_account_conflict`);
      return;
    }

    const existingUser = existingByGoogle ?? existingByEmail;

    let user: StoredUser;

    if (existingUser) {
      user = {
        ...existingUser,
        googleId,
        displayName: existingUser.displayName || displayName,
        lastSeenAt: Date.now(),
        presenceState: 'online',
      };
    } else {
      user = {
        id: randomUUID(),
        handle: buildUniqueHandle(displayName),
        email,
        displayName,
        provider: 'google',
        createdAt: Date.now(),
        sharePresence: true,
        presenceState: 'online',
        lastSeenAt: Date.now(),
        passwordHash: null,
        passwordSalt: null,
        googleId,
      };
    }

    await upsertUser(user);

    const session = {
      token: createSessionToken(),
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: createSessionExpiry(),
    };

    await upsertSession(session);
    response.setHeader('Set-Cookie', serializeSessionCookie(session.token));
    response.redirect(returnOrigin);
  } catch {
    response.redirect(`${returnOrigin}/?authError=google_auth_failed`);
  }
});

app.post('/api/auth/register', async (request, response) => {
  const body = request.body as Partial<RegisterPayload>;
  const email = normalizeEmail(body.email ?? '');
  const password = body.password ?? '';
  const displayName = normalizeDisplayName(body.displayName ?? '');

  if (!isEmailLike(email)) {
    response.status(400).json({ message: 'Enter a valid email address.' });
    return;
  }

  if (password.length < 8) {
    response.status(400).json({ message: 'Password must be at least 8 characters.' });
    return;
  }

  if (!displayName) {
    response.status(400).json({ message: 'Display name is required.' });
    return;
  }

  if (findUserByEmail(email)) {
    response.status(409).json({ message: 'An account with this email already exists.' });
    return;
  }

  const { salt, hash } = hashPassword(password);
  const user: StoredUser = {
    id: randomUUID(),
    handle: buildUniqueHandle(displayName),
    email,
    displayName,
    provider: 'local',
    createdAt: Date.now(),
    sharePresence: true,
    presenceState: 'online',
    lastSeenAt: Date.now(),
    passwordHash: hash,
    passwordSalt: salt,
    googleId: null,
  };

  await upsertUser(user);

  const session = {
    token: createSessionToken(),
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: createSessionExpiry(),
  };

  await upsertSession(session);

  response.setHeader('Set-Cookie', serializeSessionCookie(session.token));
  response.status(201).json({ user: toPublicUser(user) });
});

app.post('/api/auth/login', async (request, response) => {
  const body = request.body as Partial<AuthCredentials>;
  const email = normalizeEmail(body.email ?? '');
  const password = body.password ?? '';

  if (!isEmailLike(email) || !password) {
    response.status(400).json({ message: 'Email and password are required.' });
    return;
  }

  const user = findUserByEmail(email);

  if (!user || !user.passwordHash || !user.passwordSalt || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    response.status(401).json({ message: 'Invalid email or password.' });
    return;
  }

  const session = {
    token: createSessionToken(),
    userId: user.id,
    createdAt: Date.now(),
    expiresAt: createSessionExpiry(),
  };

  await upsertSession(session);

  response.setHeader('Set-Cookie', serializeSessionCookie(session.token));
  response.json({ user: toPublicUser(user) });
});

app.post('/api/auth/logout', async (request, response) => {
  const token = getSessionTokenFromCookie(request.headers.cookie);

  if (token) {
    await deleteSession(token);
  }

  response.setHeader('Set-Cookie', clearSessionCookie());
  response.json({ ok: true });
});

app.get('/api/profile', (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  response.json({ user });
});

app.patch('/api/profile/presence', async (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const sharePresence = Boolean(request.body?.sharePresence);
  const requestedState = String(request.body?.presenceState ?? 'online');
  const presenceState: 'online' | 'offline' = requestedState === 'offline' ? 'offline' : 'online';

  await updateUserPresenceMeta(user.id, {
    sharePresence,
    presenceState,
    lastSeenAt: presenceState === 'offline' ? Date.now() : findUserById(user.id)?.lastSeenAt ?? Date.now(),
  });

  emitPresence();
  emitFriendGraphUpdate([user.id, ...getFriendIds(user.id)]);

  const updated = findUserById(user.id);
  response.json({ user: updated ? toPublicUser(updated) : user });
});

app.get('/api/friends', (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const friends = getFriendIds(user.id)
    .map((id) => findUserById(id))
    .filter((entry): entry is StoredUser => Boolean(entry))
    .map((entry) => {
      const publicUser = toPublicUser(entry);
      const presence = getPresenceForFriend(user.id, entry);
      return {
        ...publicUser,
        isOnline: presence.isOnline,
        lastSeenAt: presence.lastSeenAt,
        isPresenceVisible: presence.isVisible,
        isPrivate: isPrivateChat(user.id, entry.id),
      };
    });

  response.json({ friends, onlineUserIds: onlineUserIds() });
});

app.get('/api/users/search', (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const query = String(request.query.query ?? '');
  const users = searchUsersByEmailOrHandle(query, user.id).map((entry) => {
    const publicUser = toPublicUser(entry);
    const pending = findPendingRequestBetween(user.id, publicUser.id);

    return {
      ...publicUser,
      isFriend: areFriends(user.id, publicUser.id),
      hasPendingRequest: Boolean(pending),
      pendingDirection:
        pending && pending.fromUserId === user.id ? 'outgoing' : pending && pending.toUserId === user.id ? 'incoming' : null,
    };
  });

  response.json({ users });
});

app.post('/api/friends/request', async (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const targetRaw = String(request.body?.target ?? '').trim();
  if (!targetRaw) {
    response.status(400).json({ message: 'Provide an email or user id.' });
    return;
  }

  const target = isEmailLike(targetRaw) ? findUserByEmail(targetRaw) : findUserByHandle(targetRaw);

  if (!target) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }

  if (target.id === user.id) {
    response.status(400).json({ message: 'You cannot send a request to yourself.' });
    return;
  }

  if (areFriends(user.id, target.id)) {
    response.status(409).json({ message: 'You are already friends.' });
    return;
  }

  if (findPendingRequestBetween(user.id, target.id)) {
    response.status(409).json({ message: 'A friend request already exists.' });
    return;
  }

  const created = await createFriendRequest(user.id, target.id);
  emitFriendGraphUpdate([user.id, target.id]);
  response.status(201).json({ request: requestWithUsers(created, user.id) });
});

app.post('/api/friends/requests/:requestId/respond', async (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const action = String(request.body?.action ?? '');
  const nextStatus = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : null;

  if (!nextStatus) {
    response.status(400).json({ message: 'Action must be accept or reject.' });
    return;
  }

  const updated = await respondToFriendRequest(request.params.requestId, user.id, nextStatus);

  if (!updated) {
    response.status(404).json({ message: 'Request not found.' });
    return;
  }

  emitFriendGraphUpdate([updated.fromUserId, updated.toUserId]);
  response.json({ request: requestWithUsers(updated, user.id) });
});

app.get('/api/friends/requests', (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const grouped = listFriendRequestsForUser(user.id);

  response.json({
    incoming: grouped.incoming.map((entry) => requestWithUsers(entry, user.id)),
    outgoing: grouped.outgoing.map((entry) => requestWithUsers(entry, user.id)),
    history: grouped.history.map((entry) => requestWithUsers(entry, user.id)),
  });
});

app.get('/api/conversations/:peerUserId', async (request, response) => {
  const user = requireAuth(request, response);

  if (!user) {
    return;
  }

  const peer = findUserById(request.params.peerUserId);

  if (!peer) {
    response.status(404).json({ message: 'User not found.' });
    return;
  }

  if (!areFriends(user.id, peer.id)) {
    response.status(403).json({ message: 'You can only chat with accepted friends.' });
    return;
  }

  await markConversationSeen(user.id, peer.id);

  const snapshot = await buildConversationSnapshot(user, toPublicUser(peer));
  response.json(snapshot);
});

if (hasClientBuild) {
  app.get('*', (_request, response) => {
    response.sendFile(path.join(clientDist, 'index.html'));
  });
}

io.on('connection', (socket) => {
  const user = authUserFromCookie(socket.request.headers.cookie);

  if (!user) {
    socket.disconnect(true);
    return;
  }

  socket.data.user = user;
  socket.join(userRoom(user.id));

  if (!onlineSocketsByUser.has(user.id)) {
    onlineSocketsByUser.set(user.id, new Set<string>());
  }

  onlineSocketsByUser.get(user.id)?.add(socket.id);
  void updateUserPresenceMeta(user.id, { lastSeenAt: Date.now() });
  emitPresence();

  socket.on('conversation:open', async (payload: OpenConversationPayload) => {
    const viewer = socket.data.user as AuthenticatedUser;
    const peer = findUserById(payload.peerUserId);

    if (!peer) {
      socket.emit('conversation:error', { message: 'User not found.' });
      return;
    }

    if (!areFriends(viewer.id, peer.id)) {
      socket.emit('conversation:error', { message: 'Only accepted friends can chat.' });
      return;
    }

    const conversationId = conversationIdFor(viewer.id, peer.id);
    socket.join(conversationId);
    await markConversationSeen(viewer.id, peer.id);
    const snapshot = await buildConversationSnapshot(viewer, toPublicUser(peer));
    socket.emit('conversation:snapshot', snapshot);
  });

  socket.on('message:send', async (payload: SendMessagePayload) => {
    const sender = socket.data.user as AuthenticatedUser;
    const recipient = findUserById(payload.recipientId);
    const body = (payload.body ?? '').trim();

    if (!recipient) {
      socket.emit('message:error', { message: 'Recipient not found.' });
      return;
    }

    if (!areFriends(sender.id, recipient.id)) {
      socket.emit('message:error', { message: 'You can only chat with friends.' });
      return;
    }

    if (!body) {
      socket.emit('message:error', { message: 'Message cannot be empty.' });
      return;
    }

    const lineCount = calculateLineCount(body);
    const delaySeconds = calculateDelaySeconds(lineCount, payload.baseSecondsPerLine);

    const message: ChatMessage = {
      id: randomUUID(),
      senderId: sender.id,
      recipientId: recipient.id,
      sender: sender.displayName,
      body,
      mode: payload.mode,
      status: payload.mode === 'temporary' ? 'pending-open' : 'visible',
      createdAt: Date.now(),
      lineCount,
      baseSecondsPerLine: Math.max(1, Math.round(payload.baseSecondsPerLine)),
      delaySeconds,
      recipientOpenedAt: null,
      visibleToRecipientAt: null,
      expiresForRecipientAt: null,
      seenByRecipientAt: null,
    };

    await upsertMessage(message);
    await emitMessageUpserted(message);

    if (message.mode === 'temporary') {
      scheduleTemporaryExpiry(message);
    }
  });

  socket.on('message:delete', async (payload: { messageId?: string }) => {
    const actor = socket.data.user as AuthenticatedUser;
    const messageId = payload?.messageId ?? '';
    const target = listMessages().find((entry) => entry.id === messageId);

    if (!target) {
      socket.emit('message:error', { message: 'Message not found.' });
      return;
    }

    if (target.mode !== 'permanent') {
      socket.emit('message:error', { message: 'Only permanent messages can be deleted manually.' });
      return;
    }

    if (target.senderId !== actor.id) {
      socket.emit('message:error', { message: 'You can only delete your own messages.' });
      return;
    }

    clearExpiryTimer(target.id);
    await removeMessage(target.id);
    await emitMessageRemoved(target);
  });

  socket.on('conversation:delete', async (payload: { peerUserId?: string }) => {
    const actor = socket.data.user as AuthenticatedUser;
    const peerId = payload?.peerUserId ?? '';
    const peer = findUserById(peerId);

    if (!peer) {
      socket.emit('conversation:error', { message: 'User not found.' });
      return;
    }

    if (!areFriends(actor.id, peer.id)) {
      socket.emit('conversation:error', { message: 'Only accepted friends can chat.' });
      return;
    }

    const removed = await removeConversationMessages(actor.id, peer.id);

    for (const message of removed) {
      clearExpiryTimer(message.id);
      await emitMessageRemoved(message);
    }
  });

  socket.on('conversation:toggle-private', async (payload: { peerUserId?: string }) => {
    const actor = socket.data.user as AuthenticatedUser;
    const peerId = payload?.peerUserId ?? '';
    const peer = findUserById(peerId);

    if (!peer) {
      socket.emit('conversation:error', { message: 'User not found.' });
      return;
    }

    if (!areFriends(actor.id, peer.id)) {
      socket.emit('conversation:error', { message: 'Only accepted friends can chat.' });
      return;
    }

    const isNowPrivate = await togglePrivateChat(actor.id, peer.id);
    io.to(userRoom(actor.id)).emit('friends:updated');
    socket.emit('conversation:private-toggled', { peerUserId: peerId, isPrivate: isNowPrivate });
  });

  socket.on('disconnect', () => {
    const sockets = onlineSocketsByUser.get(user.id);

    if (!sockets) {
      return;
    }

    sockets.delete(socket.id);

    if (sockets.size === 0) {
      onlineSocketsByUser.delete(user.id);
      void updateUserPresenceMeta(user.id, { lastSeenAt: Date.now() });
    }

    emitPresence();
  });
});

async function hydrateTimers() {
  for (const message of listMessages()) {
    if (message.mode !== 'temporary') {
      continue;
    }

    if (!message.expiresForRecipientAt) {
      continue;
    }

    if (message.expiresForRecipientAt <= Date.now()) {
      await removeMessage(message.id);
      continue;
    }

    scheduleTemporaryExpiry(message);
  }
}

async function main() {
  await loadStore();

  const allUsers = listUsers();
  if (allUsers.length >= 2) {
    const legacyA = allUsers[0];
    const legacyB = allUsers[1];
    if (!areFriends(legacyA.id, legacyB.id) && listAllRequestsForUser(legacyA.id).length === 0) {
      await addFriendship(legacyA.id, legacyB.id);
    }
  }

  await hydrateTimers();

  server.listen(port, () => {
    console.log(`Chatify server running on http://localhost:${port}`);
  });
}

void main();
