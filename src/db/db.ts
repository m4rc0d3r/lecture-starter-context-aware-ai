import Dexie, { type EntityTable } from 'dexie';

export type Role = 'user' | 'assistant' | 'system';

// Message interface
export interface Message {
  id?: number;
  threadId: string;
  role: Role;
  text: string;
  timestamp: number;
}

// Rolling summary interface
export interface Summary {
  id?: number;
  threadId: string;
  upToTs: number; // Timestamp up to which this summary covers
  text: string;
}

// Extracted facts interface
export interface Fact {
  id?: number;
  threadId: string;
  key: string;
  value: string;
  sourceMsgId: number;
  lastUpdatedAt: number;
}

export type EmbeddingSourceType = 'message' | 'documentChunk';

// Embedding vector interface
export interface Embedding {
  id?: number;
  threadId: string;
  sourceType: EmbeddingSourceType;
  sourceId: number;
  dim: number; // Dimension of the embedding
  vec: Blob; // Float32Array stored as Blob
}

// HNSW index storage interface
export interface HNSWIndex {
  threadId: string; // Primary key
  blob: ArrayBuffer; // Serialized HNSW index
}

export interface Document {
  id?: number;
  threadId: string;
  name: string;
}

export interface DocumentChunk {
  id?: number;
  documentId: number;
  index: number;
  text: string;
  timestamp: number;
}

// Define the database
const db = new Dexie('offchat-bsa') as Dexie & {
  messages: EntityTable<Message, 'id'>;
  summaries: EntityTable<Summary, 'id'>;
  facts: EntityTable<Fact, 'id'>;
  embeddings: EntityTable<Embedding, 'id'>;
  hnsw: EntityTable<HNSWIndex, 'threadId'>;
  documents: EntityTable<Document, 'id'>;
  documentChunks: EntityTable<DocumentChunk, 'id'>;
};

// Schema declaration
db.version(1).stores({
  messages: '++id, threadId, timestamp, role',
  summaries: '++id, threadId, upToTs',
  facts: '++id, threadId, key, sourceMsgId',
  embeddings: '++id, threadId, [sourceType+sourceId]',
  hnsw: 'threadId',
  documents: '++id, threadId',
  documentChunks: '++id, documentId',
});

export { db };
