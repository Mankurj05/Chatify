import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, FriendRequest, FriendRequestStatus, StoredSession, StoredUser } from '../shared/types';

interface PersistedState {
  messages: ChatMessage[];
  users: Record<string, StoredUser>;
  sessions: Record<string, StoredSession>;
  friendships: Record<string, string[]>;
  friendRequests: FriendRequest[];
  privateChats: Record<string, string[]>;
}

const dataFile = join(process.cwd(), 'data', 'chat-store.json');

let state: PersistedState = {
  messages: [],
  users: {},
  sessions: {},
  friendships: {},
  friendRequests: [],
  privateChats: {},
};
let writeQueue = Promise.resolve();

function normalizeHandleFromUser(user: Partial<StoredUser>) {
  const seed = (user.displayName ?? user.email ?? user.id ?? 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = (seed || 'user').slice(0, 12);
  const suffix = (user.id ?? randomUUID()).replace(/[^a-z0-9]/g, '').slice(0, 4).padEnd(4, '0');
  return `${base}${suffix}`;
}

function normalizeUserRecord(user: Partial<StoredUser>): StoredUser {
  return {
    id: user.id ?? randomUUID(),
    handle: user.handle?.toLowerCase() ?? normalizeHandleFromUser(user),
    email: user.email ?? 'unknown@example.com',
    displayName: user.displayName ?? 'Unknown',
    provider: user.provider ?? 'local',
    createdAt: user.createdAt ?? Date.now(),
    sharePresence: user.sharePresence ?? true,
    presenceState: user.presenceState ?? 'online',
    lastSeenAt: user.lastSeenAt ?? Date.now(),
    passwordHash: user.passwordHash ?? null,
    passwordSalt: user.passwordSalt ?? null,
    googleId: user.googleId ?? null,
  };
}

function normalizeMessageRecord(message: Partial<ChatMessage>): ChatMessage {
  return {
    id: message.id ?? randomUUID(),
    senderId: message.senderId ?? '',
    recipientId: message.recipientId ?? '',
    sender: message.sender ?? 'Unknown',
    body: message.body ?? '',
    mode: message.mode ?? 'permanent',
    status: message.status ?? 'visible',
    createdAt: message.createdAt ?? Date.now(),
    lineCount: message.lineCount ?? 1,
    baseSecondsPerLine: message.baseSecondsPerLine ?? 1,
    delaySeconds: message.delaySeconds ?? 0,
    recipientOpenedAt: message.recipientOpenedAt ?? null,
    visibleToRecipientAt: message.visibleToRecipientAt ?? null,
    expiresForRecipientAt: message.expiresForRecipientAt ?? null,
    seenByRecipientAt: message.seenByRecipientAt ?? null,
  };
}

export async function loadStore() {
  await mkdir(dirname(dataFile), { recursive: true });

  try {
    const raw = await readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;

    const normalizedUsers = Object.fromEntries(
      Object.entries(parsed.users ?? {}).map(([key, value]) => [key, normalizeUserRecord(value as Partial<StoredUser>)])
    );

    state = {
      messages: (parsed.messages ?? []).map((entry) => normalizeMessageRecord(entry as Partial<ChatMessage>)),
      users: normalizedUsers,
      sessions: parsed.sessions ?? {},
      friendships: parsed.friendships ?? {},
      friendRequests: parsed.friendRequests ?? [],
      privateChats: parsed.privateChats ?? {},
    };

    for (const userId of Object.keys(state.users)) {
      if (!state.friendships[userId]) {
        state.friendships[userId] = [];
      }
      if (!state.privateChats[userId]) {
        state.privateChats[userId] = [];
      }
    }
  } catch {
    state = {
      messages: [],
      users: {},
      sessions: {},
      friendships: {},
      friendRequests: [],
      privateChats: {},
    };

    await persistStore();
  }
}

async function persistStore() {
  const payload = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(() => writeFile(dataFile, payload, 'utf8'));
  await writeQueue;
}

export function getConversationMessages(userA: string, userB: string) {
  return state.messages
    .filter(
      (message) =>
        (message.senderId === userA && message.recipientId === userB) ||
        (message.senderId === userB && message.recipientId === userA)
    )
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function listMessages() {
  return [...state.messages].sort((left, right) => left.createdAt - right.createdAt);
}

export async function upsertMessage(message: ChatMessage) {
  const index = state.messages.findIndex((entry) => entry.id === message.id);

  if (index >= 0) {
    state.messages[index] = message;
  } else {
    state.messages.push(message);
  }

  state.messages.sort((left, right) => left.createdAt - right.createdAt);
  await persistStore();
}

export async function removeMessage(messageId: string) {
  const before = state.messages.length;
  state.messages = state.messages.filter((entry) => entry.id !== messageId);

  if (state.messages.length !== before) {
    await persistStore();
  }
}

export async function removeConversationMessages(userA: string, userB: string) {
  const removed = state.messages.filter(
    (message) =>
      (message.senderId === userA && message.recipientId === userB) ||
      (message.senderId === userB && message.recipientId === userA)
  );

  if (removed.length === 0) {
    return [];
  }

  state.messages = state.messages.filter(
    (message) =>
      !(
        (message.senderId === userA && message.recipientId === userB) ||
        (message.senderId === userB && message.recipientId === userA)
      )
  );

  await persistStore();
  return removed;
}

export function findUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return Object.values(state.users).find((entry) => entry.email.toLowerCase() === normalized) ?? null;
}

export function findUserById(userId: string) {
  return state.users[userId] ?? null;
}

export function findUserByHandle(handle: string) {
  const normalized = handle.trim().toLowerCase();
  return Object.values(state.users).find((entry) => (entry.handle ?? '').toLowerCase() === normalized) ?? null;
}

export function findUserByGoogleId(googleId: string) {
  const normalized = googleId.trim();
  return Object.values(state.users).find((entry) => entry.googleId === normalized) ?? null;
}

export async function upsertUser(user: StoredUser) {
  state.users[user.id] = user;

  if (!state.friendships[user.id]) {
    state.friendships[user.id] = [];
  }

  await persistStore();
}

export function listUsers() {
  return Object.values(state.users).sort((left, right) => left.displayName.localeCompare(right.displayName));
}

export function getSession(token: string) {
  const session = state.sessions[token];

  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    delete state.sessions[token];
    void persistStore();
    return null;
  }

  return session;
}

export async function upsertSession(session: StoredSession) {
  state.sessions[session.token] = session;
  await persistStore();
}

export async function deleteSession(token: string) {
  if (state.sessions[token]) {
    delete state.sessions[token];
    await persistStore();
  }
}

export function areFriends(userA: string, userB: string) {
  return (state.friendships[userA] ?? []).includes(userB) && (state.friendships[userB] ?? []).includes(userA);
}

export function getFriendIds(userId: string) {
  return [...(state.friendships[userId] ?? [])].sort((left, right) => left.localeCompare(right));
}

export async function addFriendship(userA: string, userB: string) {
  if (!state.friendships[userA]) {
    state.friendships[userA] = [];
  }

  if (!state.friendships[userB]) {
    state.friendships[userB] = [];
  }

  if (!state.friendships[userA].includes(userB)) {
    state.friendships[userA].push(userB);
  }

  if (!state.friendships[userB].includes(userA)) {
    state.friendships[userB].push(userA);
  }

  state.friendships[userA].sort((left, right) => left.localeCompare(right));
  state.friendships[userB].sort((left, right) => left.localeCompare(right));

  await persistStore();
}

export function findPendingRequestBetween(userA: string, userB: string) {
  return (
    state.friendRequests.find(
      (request) =>
        request.status === 'pending' &&
        ((request.fromUserId === userA && request.toUserId === userB) ||
          (request.fromUserId === userB && request.toUserId === userA))
    ) ?? null
  );
}

export async function createFriendRequest(fromUserId: string, toUserId: string) {
  const request: FriendRequest = {
    id: randomUUID(),
    fromUserId,
    toUserId,
    status: 'pending',
    createdAt: Date.now(),
    respondedAt: null,
  };

  state.friendRequests.push(request);
  await persistStore();
  return request;
}

export function listFriendRequestsForUser(userId: string) {
  const incoming = state.friendRequests.filter((entry) => entry.toUserId === userId && entry.status === 'pending');
  const outgoing = state.friendRequests.filter((entry) => entry.fromUserId === userId && entry.status === 'pending');
  const history = state.friendRequests.filter(
    (entry) => (entry.fromUserId === userId || entry.toUserId === userId) && entry.status !== 'pending'
  );

  history.sort((left, right) => (right.respondedAt ?? right.createdAt) - (left.respondedAt ?? left.createdAt));

  return { incoming, outgoing, history };
}

export function listAllRequestsForUser(userId: string) {
  return state.friendRequests.filter((entry) => entry.fromUserId === userId || entry.toUserId === userId);
}

export async function respondToFriendRequest(requestId: string, responderId: string, status: Extract<FriendRequestStatus, 'accepted' | 'rejected'>) {
  const target = state.friendRequests.find((entry) => entry.id === requestId);

  if (!target) {
    return null;
  }

  if (target.toUserId !== responderId || target.status !== 'pending') {
    return null;
  }

  target.status = status;
  target.respondedAt = Date.now();

  if (status === 'accepted') {
    await addFriendship(target.fromUserId, target.toUserId);
    return target;
  }

  await persistStore();
  return target;
}

export function searchUsersByEmailOrHandle(query: string, currentUserId: string) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  return listUsers().filter((entry) => {
    if (entry.id === currentUserId) {
      return false;
    }

    return entry.email.toLowerCase().includes(normalized) || entry.handle.toLowerCase().includes(normalized);
  });
}

export function isPrivateChat(userId: string, peerId: string) {
  return (state.privateChats[userId] ?? []).includes(peerId);
}

export async function togglePrivateChat(userId: string, peerId: string) {
  if (!state.privateChats[userId]) {
    state.privateChats[userId] = [];
  }

  const index = state.privateChats[userId].indexOf(peerId);
  if (index >= 0) {
    state.privateChats[userId].splice(index, 1);
  } else {
    state.privateChats[userId].push(peerId);
  }

  state.privateChats[userId].sort((left, right) => left.localeCompare(right));
  await persistStore();
  return isPrivateChat(userId, peerId);
}

export function getPrivateChatIds(userId: string) {
  return [...(state.privateChats[userId] ?? [])].sort((left, right) => left.localeCompare(right));
}
