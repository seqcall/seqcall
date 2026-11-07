/** Port with a single implementation (FileNotes): the I/O scan follows it (FR-17.5). */
export interface NoteStore {
  write(id: string, text: string): Promise<void>;
}
