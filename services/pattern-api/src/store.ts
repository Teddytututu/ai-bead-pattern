import { DatabaseSync } from 'node:sqlite'
import type { ApiErrorBody, CreateJobRequest, JobState, ResultView } from '@ai-bead-pattern/pattern-api-contracts'
import type { MaterialPalette, BeadPattern } from '@ai-bead-pattern/pattern-core'

export interface Stored { id: string; owner: string; expiresAt: number }
export interface ImageRecord extends Stored { width: number; height: number; hash: string }
export interface JobRecord extends Stored {
  imageId: string; state: JobState; stage: string; request: CreateJobRequest; palette: MaterialPalette
  algorithmVersion: string
  createdAt: number; updatedAt: number; error?: ApiErrorBody
}
export interface SavedResult { view: ResultView; patterns: Record<string, BeadPattern> }
export class Store {
  readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_owner ON records(kind,owner);
      CREATE TABLE IF NOT EXISTS idempotency (owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, jobId TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,key));`)
  }
  put(kind: string, value: Stored): void {
    this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)').run(kind, value.id, value.owner, value.expiresAt, JSON.stringify(value))
  }
  get<T extends Stored>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(String(row.data)) as T : undefined
  }
  list<T extends Stored>(kind: string, owner?: string): T[] {
    const rows = owner === undefined ? this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind)
      : this.db.prepare('SELECT data FROM records WHERE kind=? AND owner=?').all(kind, owner)
    return rows.map(r => JSON.parse(String(r.data)) as T)
  }
  remove(kind: string, id: string): void { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id) }
  close(): void { this.db.close() }
}
