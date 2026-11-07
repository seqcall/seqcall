import { readFile, writeFile } from 'node:fs/promises';
import type { NoteStore } from '../ports/note-store';

/** Infrastructure adapter: notes as files (FR-17 fixture). */
export class FileNotes implements NoteStore {
  constructor(private readonly dir: string) {}

  async read(id: string): Promise<string> {
    return readFile(this.path(id), 'utf8');
  }

  async write(id: string, text: string): Promise<void> {
    await writeFile(this.path(id), text);
  }

  private path(id: string): string {
    return `${this.dir}/${id}.txt`;
  }
}
