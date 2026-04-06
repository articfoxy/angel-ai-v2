export interface User {
  id: string;
  email: string;
  name: string | null;
  preferences?: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface Session {
  id: string;
  userId?: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  summary?: unknown;
  speakers?: Record<string, string>; // { "speaker_0": "Owner", "speaker_1": "Sarah" }
  skills?: string[];
  episodes?: Episode[];
}

export interface Episode {
  id: string;
  sessionId: string;
  speaker: string;
  content: string;
  startTime: string;
  endTime: string;
}

export interface TranscriptSegment {
  id: string;
  text: string;
  speaker?: string;
  speakerLabel?: string; // "Owner", "Person A", etc.
  timestamp: number;
  isFinal: boolean;
}

export interface WhisperCardData {
  id: string;
  type: string;
  content: string;
  detail?: string | null;
  confidence?: number;
  priority?: string;
  createdAt?: string;
}

export interface Memory {
  id: string;
  content: string;
  importance: number;
  category?: string;
  validFrom: string;
  validTo?: string | null;
  accessCount: number;
  lastAccessed?: string | null;
  source?: string | null;
}

export interface Entity {
  id: string;
  name: string;
  type: string; // person, place, org, topic
  aliases: string[];
  metadata?: Record<string, unknown> | null;
}

export interface Relationship {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  weight: number;
  validFrom: string;
  validTo?: string | null;
}

export interface Reflection {
  id: string;
  content: string;
  importance: number;
  sourceMemories: string[];
}

export interface CoreMemory {
  id: string;
  userProfile: string;
  preferences: string;
  keyPeople: string;
  activeGoals: string;
  updatedAt: string;
}

export interface Skill {
  id: string;
  userId: string;
  name: string;
  trigger?: string;
  systemPrompt: string;
  outputSchema?: Record<string, unknown>;
  visibility: string;
  downloads: number;
}

export interface SessionsListResponse {
  sessions: Session[];
  total: number;
}
