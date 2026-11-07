import type { NoteStore } from '../ports/note-store';

export class Archiver {
  constructor(private readonly store: NoteStore) {}

  async run(id: string): Promise<void> {
    await this.keep(id, `archived ${id}`);
  }

  private async keep(id: string, text: string): Promise<void> {
    await this.store.write(`archive/${id}`, text);
  }
}
