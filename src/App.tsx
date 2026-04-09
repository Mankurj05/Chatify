import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { AuthenticatedUser, ChatMessage, ChatMode, ConversationSnapshot, FriendRequest } from '../shared/types';

type RequestView = FriendRequest & {
  direction: 'incoming' | 'outgoing';
  fromUser: AuthenticatedUser | null;
  toUser: AuthenticatedUser | null;
};

type FriendUser = AuthenticatedUser & {
  isOnline: boolean;
  lastSeenAt: number | null;
  isPresenceVisible: boolean;
  isPrivate: boolean;
};

type SearchUser = AuthenticatedUser & {
  isFriend: boolean;
  hasPendingRequest: boolean;
  pendingDirection: 'incoming' | 'outgoing' | null;
};

type TabKey = 'chats' | 'private-chats' | 'requests' | 'profile';
const DELETE_HOLD_MS = 700;

const emailStorageKey = 'chatify-email';

function getStoredEmail() {
  return localStorage.getItem(emailStorageKey) ?? '';
}

function formatClock(ms: number) {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

function formatDate(ms: number) {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(ms));
}

function lineCount(text: string) {
  return Math.max(1, text.trim().length === 0 ? 1 : text.split(/\r?\n/).length);
}

function clampSeconds(value: number) {
  return Math.max(1, Math.min(30, Math.round(value)));
}

function formatCountdown(ms: number) {
  if (ms <= 0) {
    return 'now';
  }

  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function conversationIdFor(a: string, b: string) {
  return [a, b].sort((left, right) => left.localeCompare(right)).join(':');
}

function mergeMessage(list: ChatMessage[], message: ChatMessage) {
  const index = list.findIndex((entry) => entry.id === message.id);

  if (index >= 0) {
    const next = [...list];
    next[index] = message;
    return next.sort((left, right) => left.createdAt - right.createdAt);
  }

  return [...list, message].sort((left, right) => left.createdAt - right.createdAt);
}

function isVisibleToViewer(message: ChatMessage, viewerId: string) {
  if (message.mode === 'permanent') {
    return true;
  }

  if (message.senderId === viewerId) {
    return true;
  }

  return message.status === 'visible';
}

function friendPresenceText(friend: FriendUser) {
  if (!friend.isPresenceVisible) {
    return 'status hidden';
  }

  if (friend.isOnline) {
    return 'online';
  }

  if (!friend.lastSeenAt) {
    return 'offline';
  }

  return `last seen ${formatDate(friend.lastSeenAt)} ${formatClock(friend.lastSeenAt)}`;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8h11v13H8z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 16H4V4h12v1" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ForwardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12h11" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11 6l7 6-7 6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 7V5h6v2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 7l1 12h6l1-12" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M11 10v6M13 10v6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor" />
    </svg>
  );
}

function countUnseenInConversation(messages: ChatMessage[], userId: string, peerId: string): number {
  return messages.filter(
    (msg) =>
      msg.senderId === peerId &&
      msg.recipientId === userId &&
      !msg.seenByRecipientAt
  ).length;
}

function AuthPanel({
  mode,
  email,
  password,
  displayName,
  busy,
  message,
  onMode,
  onEmail,
  onPassword,
  onDisplayName,
  onSubmit,
  onGoogleAuth,
  googleEnabled,
}: {
  mode: 'login' | 'register';
  email: string;
  password: string;
  displayName: string;
  busy: boolean;
  message: string;
  onMode: (mode: 'login' | 'register') => void;
  onEmail: (value: string) => void;
  onPassword: (value: string) => void;
  onDisplayName: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onGoogleAuth: () => void;
  googleEnabled: boolean;
}) {
  return (
    <main className="layout layout--auth">
      <section className="auth-card">
        <div className="auth-card__copy">
          <div className="eyebrow">Chatify</div>
          <h1>Friends-only chat with disappearing temporary messages.</h1>
          <p>
            Add friends via requests, chat one-to-one, use copy/forward quick actions, and control your online status
            visibility for friends.
          </p>
        </div>

        <div className="auth-card__panel">
          <div className="segmented segmented--auth">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => onMode('login')}>
              Sign in
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => onMode('register')}>
              Create account
            </button>
          </div>

          <form className="auth-form" onSubmit={onSubmit}>
            {mode === 'register' ? (
              <label>
                <span>Display name</span>
                <input value={displayName} onChange={(event) => onDisplayName(event.target.value)} placeholder="Mayank" />
              </label>
            ) : null}

            <label>
              <span>Email</span>
              <input type="email" value={email} onChange={(event) => onEmail(event.target.value)} placeholder="you@example.com" />
            </label>

            <label>
              <span>Password</span>
              <input type="password" value={password} onChange={(event) => onPassword(event.target.value)} placeholder="At least 8 characters" />
            </label>

            <button type="submit" disabled={busy}>
              {busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <button type="button" className="google-button" onClick={onGoogleAuth} disabled={!googleEnabled || busy}>
            {googleEnabled ? 'Continue with Google' : 'Google auth not configured'}
          </button>

          {message ? <div className="auth-message">{message}</div> : null}
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const socketRef = useRef<Socket | null>(null);
  const activePeerRef = useRef<string | null>(null);
  const userRef = useRef<AuthenticatedUser | null>(null);

  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState(getStoredEmail());
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState('');
  const [googleAuthEnabled, setGoogleAuthEnabled] = useState(false);

  const [tab, setTab] = useState<TabKey>('chats');
  const [status, setStatus] = useState('Connecting...');
  const [connected, setConnected] = useState(false);

  const [friends, setFriends] = useState<FriendUser[]>([]);
  const [activePeer, setActivePeer] = useState<FriendUser | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);

  const [incomingRequests, setIncomingRequests] = useState<RequestView[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<RequestView[]>([]);
  const [historyRequests, setHistoryRequests] = useState<RequestView[]>([]);

  const [messageText, setMessageText] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('temporary');
  const [secondsPerLine, setSecondsPerLine] = useState(3);
  const [now, setNow] = useState(Date.now());

  const [presenceState, setPresenceState] = useState<'online' | 'offline'>('online');
  const [sharePresence, setSharePresence] = useState(true);
  const [presenceBusy, setPresenceBusy] = useState(false);
  const [forwardMessageDraft, setForwardMessageDraft] = useState<ChatMessage | null>(null);
  const [deleteHoldingId, setDeleteHoldingId] = useState<string | null>(null);
  const deleteHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftLines = useMemo(() => lineCount(messageText), [messageText]);
  const draftDelay = draftLines * clampSeconds(secondsPerLine);
  const forwardTargets = useMemo(
    () =>
      friends.filter((entry) => {
        if (!forwardMessageDraft || !user) {
          return false;
        }

        if (entry.id === user.id) {
          return false;
        }

        return !(entry.id === forwardMessageDraft.senderId || entry.id === forwardMessageDraft.recipientId);
      }),
    [friends, forwardMessageDraft, user]
  );

  const privateChatIds = useMemo(() => new Set(friends.filter((f) => f.isPrivate).map((f) => f.id)), [friends]);
  const friendsChats = useMemo(() => friends.filter((f) => !f.isPrivate), [friends]);
  const privateChats = useMemo(() => friends.filter((f) => f.isPrivate), [friends]);

  const unseenFriendsCount = useMemo(
    () =>
      friendsChats.reduce((count, friend) => {
        return count + countUnseenInConversation(messages, user?.id ?? '', friend.id);
      }, 0),
    [friendsChats, messages, user?.id]
  );

  const unseenPrivateCount = useMemo(
    () =>
      privateChats.reduce((count, friend) => {
        return count + countUnseenInConversation(messages, user?.id ?? '', friend.id);
      }, 0),
    [privateChats, messages, user?.id]
  );

  const displayedChats = tab === 'private-chats' ? privateChats : friendsChats;

  useEffect(() => {
    userRef.current = user;
    if (user) {
      setPresenceState(user.presenceState);
      setSharePresence(user.sharePresence);
    }
  }, [user]);

  useEffect(() => {
    activePeerRef.current = activePeer?.id ?? null;
  }, [activePeer]);

  useEffect(() => {
    localStorage.setItem(emailStorageKey, authEmail);
  }, [authEmail]);

  useEffect(
    () => () => {
      if (deleteHoldTimerRef.current) {
        clearTimeout(deleteHoldTimerRef.current);
        deleteHoldTimerRef.current = null;
      }
    },
    []
  );

  async function fetchMe() {
    const response = await fetch('/api/auth/me', { credentials: 'include' });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { user: AuthenticatedUser };
    return data.user;
  }

  async function loadFriends() {
    const response = await fetch('/api/friends', { credentials: 'include' });

    if (!response.ok) {
      throw new Error('Unable to load friends');
    }

    const data = (await response.json()) as { friends: FriendUser[] };

    setFriends(data.friends);

    if (!activePeerRef.current && data.friends.length > 0) {
      setActivePeer(data.friends[0]);
      activePeerRef.current = data.friends[0].id;
    }

    if (activePeerRef.current) {
      const refreshedPeer = data.friends.find((entry) => entry.id === activePeerRef.current);
      if (refreshedPeer) {
        setActivePeer(refreshedPeer);
      } else {
        setActivePeer(null);
        setMessages([]);
      }
    }
  }

  async function loadRequests() {
    const response = await fetch('/api/friends/requests', { credentials: 'include' });

    if (!response.ok) {
      throw new Error('Unable to load requests');
    }

    const data = (await response.json()) as {
      incoming: RequestView[];
      outgoing: RequestView[];
      history: RequestView[];
    };

    setIncomingRequests(data.incoming);
    setOutgoingRequests(data.outgoing);
    setHistoryRequests(data.history);
  }

  async function loadConversation(peerId: string) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(peerId)}`, { credentials: 'include' });

    if (!response.ok) {
      setMessages([]);
      return;
    }

    const snapshot = (await response.json()) as ConversationSnapshot;
    setMessages(snapshot.messages);
  }

  useEffect(() => {
    void (async () => {
      const me = await fetchMe();

      const providers = await fetch('/api/auth/providers', { credentials: 'include' })
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null) as { supported?: string[] } | null;

      setGoogleAuthEnabled(Boolean(providers?.supported?.includes('google')));

      const authError = new URLSearchParams(window.location.search).get('authError');
      if (authError) {
        const authErrorMessages: Record<string, string> = {
          google_not_configured: 'Google sign-in is not configured yet.',
          google_state_mismatch: 'Google sign-in expired. Please try again.',
          google_token_exchange_failed: 'Google sign-in failed while exchanging token.',
          google_missing_id_token: 'Google sign-in did not return an ID token.',
          google_invalid_token: 'Google returned an invalid token.',
          google_profile_invalid: 'Google account data could not be verified.',
          google_account_conflict: 'This Google account conflicts with another existing account.',
          google_auth_failed: 'Google sign-in failed. Please try again.',
        };

        setAuthMessage(authErrorMessages[authError] ?? 'Google sign-in failed. Please try again.');
        const cleaned = `${window.location.pathname}${window.location.hash || ''}`;
        window.history.replaceState({}, '', cleaned);
      }

      setUser(me);
      setAuthReady(true);
      setStatus(me ? 'Signed in' : 'Sign in to continue');
    })();
  }, []);

  function startGoogleAuth() {
    const returnTo = encodeURIComponent(window.location.origin);
    window.location.href = `/api/auth/google/start?returnTo=${returnTo}`;
  }

  useEffect(() => {
    if (!user) {
      return;
    }

    void loadFriends();
    void loadRequests();

    const socket = io({ path: '/socket.io' });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setStatus('Live');
      if (activePeerRef.current) {
        socket.emit('conversation:open', { peerUserId: activePeerRef.current });
      }
    });

    socket.on('disconnect', () => {
      setConnected(false);
      setStatus('Offline');
    });

    socket.on('users:presence', () => {
      void loadFriends();
    });

    socket.on('friends:updated', () => {
      void loadFriends();
      void loadRequests();
    });

    socket.on('conversation:private-toggled', () => {
      void loadFriends();
    });

    socket.on('conversation:snapshot', (snapshot: ConversationSnapshot) => {
      const currentPeer = activePeerRef.current;
      if (currentPeer && snapshot.peer.id === currentPeer) {
        setMessages(snapshot.messages);
      }
    });

    socket.on('message:upserted', (message: ChatMessage) => {
      const currentUser = userRef.current;
      const currentPeer = activePeerRef.current;

      if (!currentUser || !currentPeer) {
        return;
      }

      const activeConversation = conversationIdFor(currentUser.id, currentPeer);
      const incomingConversation = conversationIdFor(message.senderId, message.recipientId);

      if (activeConversation === incomingConversation) {
        setMessages((current) => mergeMessage(current, message));
      }
    });

    socket.on('message:removed', (event: { messageId: string; conversationId: string }) => {
      const currentUser = userRef.current;
      const currentPeer = activePeerRef.current;

      if (!currentUser || !currentPeer) {
        return;
      }

      const activeConversation = conversationIdFor(currentUser.id, currentPeer);
      if (activeConversation === event.conversationId) {
        setMessages((current) => current.filter((entry) => entry.id !== event.messageId));
      }
    });

    socket.on('conversation:error', (event: { message: string }) => {
      setStatus(event.message);
    });

    socket.on('message:error', (event: { message: string }) => {
      setStatus(event.message);
    });

    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => {
      window.clearInterval(timer);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  useEffect(() => {
    if (!activePeer || !user) {
      return;
    }

    void loadConversation(activePeer.id);
    socketRef.current?.emit('conversation:open', { peerUserId: activePeer.id });
  }, [activePeer, user]);

  useEffect(() => {
    if (tab !== 'chats' || !activePeer || !user) {
      return;
    }

    void loadConversation(activePeer.id);
  }, [tab, activePeer, user]);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage('');

    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload =
        authMode === 'login'
          ? { email: authEmail, password: authPassword }
          : { email: authEmail, password: authPassword, displayName: authDisplayName };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });

      const data = (await response.json().catch(() => ({}))) as { message?: string; user?: AuthenticatedUser };

      if (!response.ok) {
        throw new Error(data.message ?? 'Authentication failed');
      }

      if (data.user) {
        setUser(data.user);
        setAuthPassword('');
        setStatus('Signed in');
      }
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined);
    socketRef.current?.disconnect();
    setUser(null);
    setFriends([]);
    setActivePeer(null);
    setMessages([]);
    setIncomingRequests([]);
    setOutgoingRequests([]);
    setHistoryRequests([]);
    setConnected(false);
    setStatus('Signed out');
  }

  async function searchUsers() {
    const query = searchTerm.trim();
    if (!query) {
      setSearchResults([]);
      return;
    }

    setSearchBusy(true);

    try {
      const response = await fetch(`/api/users/search?query=${encodeURIComponent(query)}`, { credentials: 'include' });

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = (await response.json()) as { users: SearchUser[] };
      setSearchResults(data.users);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchBusy(false);
    }
  }

  async function sendFriendRequest(target: string) {
    const response = await fetch('/api/friends/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ target }),
    });

    const data = (await response.json().catch(() => ({}))) as { message?: string };

    if (!response.ok) {
      setStatus(data.message ?? 'Unable to send request');
      return;
    }

    setStatus('Friend request sent');
    await loadRequests();
    await searchUsers();
  }

  async function respondToRequest(requestId: string, action: 'accept' | 'reject') {
    const response = await fetch(`/api/friends/requests/${encodeURIComponent(requestId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ action }),
    });

    const data = (await response.json().catch(() => ({}))) as { message?: string };

    if (!response.ok) {
      setStatus(data.message ?? 'Unable to respond to request');
      return;
    }

    await loadRequests();
    await loadFriends();
    await searchUsers();
  }

  async function updatePresence() {
    if (!user) {
      return;
    }

    setPresenceBusy(true);

    try {
      const response = await fetch('/api/profile/presence', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sharePresence, presenceState }),
      });

      const data = (await response.json().catch(() => ({}))) as { user?: AuthenticatedUser; message?: string };

      if (!response.ok) {
        throw new Error(data.message ?? 'Could not update presence settings');
      }

      if (data.user) {
        setUser(data.user);
      }

      setStatus('Presence settings updated');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not update presence settings');
    } finally {
      setPresenceBusy(false);
    }
  }

  function openConversation(peer: FriendUser) {
    setTab('chats');
    setActivePeer(peer);
    activePeerRef.current = peer.id;
    socketRef.current?.emit('conversation:open', { peerUserId: peer.id });
  }

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activePeer || !user || !socketRef.current || !connected) {
      return;
    }

    const body = messageText.trim();
    if (!body) {
      return;
    }

    socketRef.current.emit('message:send', {
      recipientId: activePeer.id,
      body,
      mode: chatMode,
      baseSecondsPerLine: chatMode === 'temporary' ? secondsPerLine : 1,
    });

    setMessageText('');
  }

  async function copyMessage(message: ChatMessage) {
    if (message.mode === 'temporary') {
      return;
    }

    await navigator.clipboard.writeText(message.body);
    setStatus('Message copied');
  }

  function forwardMessage(message: ChatMessage) {
    if (message.mode === 'temporary') {
      return;
    }

    if (!socketRef.current || !connected || !user) {
      return;
    }
    setForwardMessageDraft(message);
  }

  function closeForwardModal() {
    setForwardMessageDraft(null);
  }

  function forwardToFriend(target: FriendUser) {
    if (!forwardMessageDraft || !socketRef.current || !connected) {
      return;
    }

    socketRef.current.emit('message:send', {
      recipientId: target.id,
      body: forwardMessageDraft.body,
      mode: forwardMessageDraft.mode,
      baseSecondsPerLine: 1,
    });

    setStatus(`Forwarded to ${target.displayName}`);
    closeForwardModal();
  }

  function deleteMessage(message: ChatMessage) {
    if (message.mode !== 'permanent' || !socketRef.current || !connected || !user) {
      return;
    }

    if (message.senderId !== user.id) {
      return;
    }

    socketRef.current.emit('message:delete', { messageId: message.id });
    setStatus('Message deleted');
  }

  function deleteActiveChat() {
    if (!activePeer || !socketRef.current || !connected) {
      return;
    }

    const accepted = window.confirm(`Delete entire chat with ${activePeer.displayName}? This cannot be undone.`);
    if (!accepted) {
      return;
    }

    socketRef.current.emit('conversation:delete', { peerUserId: activePeer.id });
    setMessages([]);
    setStatus('Chat deleted');
  }

  function togglePrivateChat() {
    if (!activePeer) {
      setStatus('No chat selected');
      return;
    }

    if (!socketRef.current) {
      setStatus('Socket not ready');
      return;
    }

    if (!connected) {
      setStatus('Not connected to server');
      return;
    }

    // Optimistic update - update local state immediately
    const newIsPrivate = !activePeer.isPrivate;
    setActivePeer({ ...activePeer, isPrivate: newIsPrivate });
    setStatus(newIsPrivate ? 'Added to private' : 'Removed from private');

    socketRef.current.emit('conversation:toggle-private', { peerUserId: activePeer.id });
  }

  function cancelDeleteHold() {
    if (deleteHoldTimerRef.current) {
      clearTimeout(deleteHoldTimerRef.current);
      deleteHoldTimerRef.current = null;
    }

    setDeleteHoldingId(null);
  }

  function startDeleteHold(message: ChatMessage) {
    if (message.mode !== 'permanent' || !user || message.senderId !== user.id) {
      return;
    }

    cancelDeleteHold();
    setDeleteHoldingId(message.id);

    deleteHoldTimerRef.current = setTimeout(() => {
      deleteMessage(message);
      cancelDeleteHold();
    }, DELETE_HOLD_MS);
  }

  async function copyHandle() {
    if (!user) {
      return;
    }

    await navigator.clipboard.writeText(user.handle);
    setStatus('User ID copied');
  }

  if (!authReady || !user) {
    return (
      <div className="app-shell">
        <div className="app-glow app-glow--left" />
        <div className="app-glow app-glow--right" />
        <AuthPanel
          mode={authMode}
          email={authEmail}
          password={authPassword}
          displayName={authDisplayName}
          busy={authBusy}
          message={authMessage}
          onMode={setAuthMode}
          onEmail={setAuthEmail}
          onPassword={setAuthPassword}
          onDisplayName={setAuthDisplayName}
          onSubmit={submitAuth}
          onGoogleAuth={startGoogleAuth}
          googleEnabled={googleAuthEnabled}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-glow app-glow--left" />
      <div className="app-glow app-glow--right" />

      <main className="main-shell">
        <header className="topbar">
          <div>
            <div className="eyebrow">Chatify</div>
            <h1>{user.displayName}</h1>
            <p>@{user.handle} · {user.email}</p>
          </div>
          <div className="topbar__status">{status} {connected ? '' : '(offline)'}</div>
        </header>

        <div className="tabs">
          <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>
            <span>Friends Chat</span>
            {unseenFriendsCount > 0 ? <span className="badge">{unseenFriendsCount}</span> : null}
          </button>
          <button className={tab === 'private-chats' ? 'active' : ''} onClick={() => setTab('private-chats')}>
            <span>Private</span>
            {unseenPrivateCount > 0 ? <span className="badge">{unseenPrivateCount}</span> : null}
          </button>
          <button className={tab === 'requests' ? 'active' : ''} onClick={() => setTab('requests')}>
            Requests & History
          </button>
          <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
            Profile
          </button>
        </div>

        {tab === 'chats' || tab === 'private-chats' ? (
          <section className="chat-layout">
            <aside className="friends-panel">
              <div className="friends-panel__header">
                <h2>{tab === 'private-chats' ? 'Private' : 'Friends'}</h2>
                <span>{displayedChats.length}</span>
              </div>
              <div className="friends-list">
                {displayedChats.length === 0 ? <div className="empty-state">{tab === 'private-chats' ? 'No private chats yet. Star a friend to add them here.' : 'No friends yet. Send a request first.'}</div> : null}
                {displayedChats.map((entry) => {
                  const unseenCount = countUnseenInConversation(messages, user?.id ?? '', entry.id);
                  return (
                    <button key={entry.id} className={`friend-item ${activePeer?.id === entry.id ? 'active' : ''} ${unseenCount > 0 ? 'has-unseen' : ''}`} onClick={() => openConversation(entry)}>
                      <div>
                        <strong>{entry.displayName}</strong>
                        <span>@{entry.handle}</span>
                      </div>
                      <div className="friend-item__right">
                        <span className={`presence-pill ${entry.isOnline ? 'on' : 'off'}`}>{friendPresenceText(entry)}</span>
                        {unseenCount > 0 ? <span className="unseen-badge">{unseenCount}</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="thread-panel">
              {activePeer ? (
                <>
                  <header className="thread-header">
                    <div>
                      <h2>{activePeer.displayName}</h2>
                      <p>@{activePeer.handle} · {friendPresenceText(activePeer)}</p>
                    </div>
                    <div className="thread-actions">
                      <button 
                        type="button" 
                        className={`thread-action ${activePeer.isPrivate ? 'is-private' : ''}`}
                        onClick={togglePrivateChat} 
                        aria-pressed={activePeer.isPrivate}
                        aria-label={activePeer.isPrivate ? 'Remove chat from private' : 'Add chat to private'}
                        title={activePeer.isPrivate ? 'Remove from private' : 'Add to private'}
                      >
                        <StarIcon />
                      </button>
                      <button type="button" className="thread-danger" onClick={deleteActiveChat} title="Delete chat">
                        Delete chat
                      </button>
                    </div>
                  </header>

                  <div className="thread-body">
                    {messages.length === 0 ? <div className="empty-state">Start chatting with your friend.</div> : null}
                    {messages.map((message) => {
                      const mine = message.senderId === user.id;
                      const visible = isVisibleToViewer(message, user.id);
                      const countdownMs = (message.expiresForRecipientAt ?? 0) - now;

                      return (
                        <article key={message.id} className={`bubble ${mine ? 'mine' : 'theirs'}`}>
                          <div className="bubble__top">
                            <strong>{mine ? 'You' : message.sender}</strong>
                            <span>{formatDate(message.createdAt)} {formatClock(message.createdAt)}</span>
                          </div>

                          <div className="bubble__body">
                            {visible ? message.body : 'Temporary message locked until you open this chat.'}
                          </div>

                          <div className="bubble__meta">
                            <span>{message.mode === 'temporary' ? 'temporary' : 'permanent'}</span>
                            {mine ? <span>{message.seenByRecipientAt ? 'seen' : 'sent'}</span> : null}
                            {message.mode === 'temporary' && message.status === 'pending-open' ? <span>starts when receiver opens chat</span> : null}
                            {message.mode === 'temporary' && message.status === 'visible' ? <span>disappears in {formatCountdown(countdownMs)}</span> : null}
                          </div>

                          {message.mode === 'permanent' ? (
                            <div className="bubble__actions">
                              <button type="button" onClick={() => void copyMessage(message)} title="Copy message">
                                <CopyIcon />
                              </button>
                              <button type="button" onClick={() => forwardMessage(message)} title="Forward message">
                                <ForwardIcon />
                              </button>
                              {mine ? (
                                <button
                                  type="button"
                                  className={`danger ${deleteHoldingId === message.id ? 'is-holding' : ''}`}
                                  onPointerDown={() => startDeleteHold(message)}
                                  onPointerUp={cancelDeleteHold}
                                  onPointerLeave={cancelDeleteHold}
                                  onPointerCancel={cancelDeleteHold}
                                  title="Press and hold to delete"
                                >
                                  <DeleteIcon />
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>

                  <form className="composer" onSubmit={sendMessage}>
                    <div className="segmented">
                      <button type="button" className={chatMode === 'temporary' ? 'active' : ''} onClick={() => setChatMode('temporary')}>
                        Temporary
                      </button>
                      <button type="button" className={chatMode === 'permanent' ? 'active' : ''} onClick={() => setChatMode('permanent')}>
                        Permanent
                      </button>
                    </div>

                    <label>
                      <span>Message</span>
                      <textarea rows={4} value={messageText} onChange={(event) => setMessageText(event.target.value)} />
                    </label>

                    {chatMode === 'temporary' ? (
                      <div className="composer__row">
                        <label>
                          <span>Seconds per line</span>
                          <input
                            type="range"
                            min={1}
                            max={10}
                            value={secondsPerLine}
                            onChange={(event) => setSecondsPerLine(Number(event.target.value))}
                          />
                        </label>
                        <div className="tempo-readout">
                          <strong>{clampSeconds(secondsPerLine)}s</strong>
                          <span>{draftLines} lines = {draftDelay}s timer</span>
                        </div>
                        <button type="submit">Send</button>
                      </div>
                    ) : (
                      <div className="composer__row composer__row--single">
                        <button type="submit">Send</button>
                      </div>
                    )}
                  </form>
                </>
              ) : (
                <div className="empty-state">Select a friend to open your one-to-one chat.</div>
              )}
            </section>
          </section>
        ) : null}

        {tab === 'requests' ? (
          <section className="requests-layout">
            <div className="search-box">
              <h2>Add New Friends</h2>
              <p>Search by email or unique user id.</p>
              <div className="search-row">
                <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="example@mail.com or user1234" />
                <button onClick={() => void searchUsers()}>{searchBusy ? 'Searching...' : 'Search'}</button>
              </div>
              <div className="search-results">
                {searchResults.map((entry) => (
                  <article key={entry.id} className="request-card">
                    <div>
                      <strong>{entry.displayName}</strong>
                      <span>@{entry.handle} · {entry.email}</span>
                    </div>
                    <div className="request-card__actions">
                      {entry.isFriend ? <span className="badge">Friend</span> : null}
                      {!entry.isFriend && entry.hasPendingRequest ? (
                        <span className="badge">{entry.pendingDirection === 'outgoing' ? 'Request sent' : 'Request received'}</span>
                      ) : null}
                      {!entry.isFriend && !entry.hasPendingRequest ? (
                        <button onClick={() => void sendFriendRequest(entry.email)}>Send request</button>
                      ) : null}
                    </div>
                  </article>
                ))}
                {searchResults.length === 0 ? <div className="empty-state">No search results yet.</div> : null}
              </div>
            </div>

            <div className="requests-grid">
              <section>
                <h3>Incoming Requests</h3>
                <div className="request-list">
                  {incomingRequests.length === 0 ? <div className="empty-state">No incoming requests.</div> : null}
                  {incomingRequests.map((request) => (
                    <article key={request.id} className="request-card">
                      <div>
                        <strong>{request.fromUser?.displayName ?? 'Unknown'}</strong>
                        <span>@{request.fromUser?.handle ?? 'unknown'}</span>
                      </div>
                      <div className="request-card__actions">
                        <button onClick={() => void respondToRequest(request.id, 'accept')}>Accept</button>
                        <button className="secondary-button" onClick={() => void respondToRequest(request.id, 'reject')}>
                          Reject
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <h3>Outgoing Requests</h3>
                <div className="request-list">
                  {outgoingRequests.length === 0 ? <div className="empty-state">No outgoing requests.</div> : null}
                  {outgoingRequests.map((request) => (
                    <article key={request.id} className="request-card">
                      <div>
                        <strong>{request.toUser?.displayName ?? 'Unknown'}</strong>
                        <span>pending</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section>
                <h3>Request History</h3>
                <div className="request-list">
                  {historyRequests.length === 0 ? <div className="empty-state">No history yet.</div> : null}
                  {historyRequests.map((request) => (
                    <article key={request.id} className="request-card">
                      <div>
                        <strong>
                          {request.direction === 'incoming'
                            ? request.fromUser?.displayName ?? 'Unknown'
                            : request.toUser?.displayName ?? 'Unknown'}
                        </strong>
                        <span>{request.status}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          </section>
        ) : null}

        {tab === 'profile' ? (
          <section className="profile-panel">
            <h2>Profile</h2>
            <div className="profile-grid">
              <div>
                <span>Display name</span>
                <strong>{user.displayName}</strong>
              </div>
              <div>
                <span>Email</span>
                <strong>{user.email}</strong>
              </div>
              <div>
                <span>Unique user id</span>
                <strong>@{user.handle}</strong>
                <button className="mini-action" onClick={() => void copyHandle()}>
                  Copy ID
                </button>
              </div>
              <div>
                <span>Provider</span>
                <strong>{user.provider}</strong>
              </div>
            </div>

            <div className="profile-controls">
              <h3>Presence settings</h3>
              <label className="switch-row">
                <input type="checkbox" checked={sharePresence} onChange={(event) => setSharePresence(event.target.checked)} />
                <span>Allow friends to see my status and last seen</span>
              </label>

              <label>
                <span>Status mode</span>
                <select value={presenceState} onChange={(event) => setPresenceState(event.target.value as 'online' | 'offline')}>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                </select>
              </label>

              <button onClick={() => void updatePresence()} disabled={presenceBusy}>
                {presenceBusy ? 'Saving...' : 'Save presence settings'}
              </button>
            </div>

            <button className="secondary-button" onClick={logout}>Sign out</button>
          </section>
        ) : null}
      </main>

      {forwardMessageDraft ? (
        <div className="modal-overlay" onClick={closeForwardModal}>
          <div className="forward-modal" onClick={(event) => event.stopPropagation()}>
            <div className="forward-modal__header">
              <h3>Forward Message</h3>
              <button className="secondary-button" onClick={closeForwardModal}>
                Close
              </button>
            </div>

            <p>Select a friend to forward this message.</p>

            <div className="forward-list">
              {forwardTargets.length === 0 ? <div className="empty-state">No available friend to forward this message.</div> : null}
              {forwardTargets.map((entry) => (
                <button key={entry.id} className="forward-item" onClick={() => forwardToFriend(entry)}>
                  <div>
                    <strong>{entry.displayName}</strong>
                    <span>@{entry.handle}</span>
                  </div>
                  <span className={`presence-pill ${entry.isOnline ? 'on' : 'off'}`}>{friendPresenceText(entry)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
