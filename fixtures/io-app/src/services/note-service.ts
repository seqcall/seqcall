import { FileNotes } from '../adapters/file-notes';

export class NoteService {
  constructor(private readonly notes: FileNotes) {}

  async load(id: string): Promise<string> {
    const text = await this.notes.read(id);
    return text.trim();
  }

  async publish(id: string): Promise<number> {
    const text = await this.load(id);
    const res = await fetch('https://example.org/notes', { method: 'POST', body: text });
    return res.status;
  }

  shout(text: string): string {
    process.stdout.write(text);
    return text.toUpperCase();
  }
}
