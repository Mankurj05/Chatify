export type ChatMode = 'permanent' | 'temporary';

export type MessageStatus = 'pending-open' | 'visible';

export type AuthProvider = 'local' | 'google';

export type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';

export interface AuthenticatedUser {
  id: string;
  handle: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  createdAt: number;
  sharePresence: boolean;
  presenceState: 'online' | 'offline';
  lastSeenAt: number | null;
}

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface RegisterPayload extends AuthCredentials {
  displayName: string;
}

export interface StoredUser extends AuthenticatedUser {
  passwordHash: string | null;
  passwordSalt: string | null;
  googleId: string | null;
}

export interface StoredSession {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: FriendRequestStatus;
  createdAt: number;
  respondedAt: number | null;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  recipientId: string;
  sender: string;
  body: string;
  mode: ChatMode;
  status: MessageStatus;
  createdAt: number;
  lineCount: number;
  baseSecondsPerLine: number;
  delaySeconds: number;
  recipientOpenedAt: number | null;
  visibleToRecipientAt: number | null;
  expiresForRecipientAt: number | null;
  seenByRecipientAt: number | null;
}

export interface ConversationSnapshot {
  conversationId: string;
  peer: AuthenticatedUser;
  messages: ChatMessage[];
  onlineUserIds: string[];
  updatedAt: number;
}

export interface OpenConversationPayload {
  peerUserId: string;
}

export interface SendMessagePayload {
  recipientId: string;
  body: string;
  mode: ChatMode;
  baseSecondsPerLine: number;
}
