import { FileNotes } from './adapters/file-notes';
import { NoteController } from './controllers/note-controller';
import { Archiver } from './services/archiver';
import { NoteService } from './services/note-service';

/** The HTTP routes (FR-32 fixture): entry points whose flows do I/O. */
interface Router {
  get(path: string, handler: (id: string) => Promise<unknown>): void;
  post(path: string, handler: (id: string) => Promise<unknown>): void;
}

const notes = new FileNotes('notes');
const controller = new NoteController(new NoteService(notes), new Archiver(notes));

/** Reads the note (FILE), posts it to another API (HTTP). */
export function shareNote(id: string): Promise<number> {
  return controller.share(id);
}

/** Reads the note (FILE). */
export function showNote(id: string): Promise<string> {
  return controller.show(id);
}

export function routes(app: Router): void {
  app.post('/notes/:id/share', shareNote);
  app.get('/notes/:id', showNote);
}
