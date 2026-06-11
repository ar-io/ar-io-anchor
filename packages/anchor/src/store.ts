// The durability plug point (PRD): chain heads now, the batcher's pending
// buffer next. MemoryStore is the zero-dependency default — with it, a crash
// loses buffered *proofs*, never data (everything is re-anchorable from the
// caller's system). Durable stores (sqlite/redis/...) ship later as adapter
// packages implementing this same interface.

export interface PendingLeaf {
  // Opaque to the store; the batcher owns the shape.
  [key: string]: unknown;
}

export interface Store {
  getHead(key: string): Promise<string | null>;
  setHead(key: string, hash: string): Promise<void>;
  appendPending(leaf: PendingLeaf): Promise<void>;
  takePending(): Promise<PendingLeaf[]>;
}

export class MemoryStore implements Store {
  private readonly heads = new Map<string, string>();
  private pending: PendingLeaf[] = [];

  async getHead(key: string): Promise<string | null> {
    return this.heads.get(key) ?? null;
  }

  async setHead(key: string, hash: string): Promise<void> {
    this.heads.set(key, hash);
  }

  async appendPending(leaf: PendingLeaf): Promise<void> {
    this.pending.push(leaf);
  }

  async takePending(): Promise<PendingLeaf[]> {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
