/** Port with two implementations that both call HTTP: the I/O all of them do counts (FR-17.5). */
export interface Notifier {
  notify(id: string): Promise<void>;
}

/** Port with two implementations, only one of them writes a file: no badge. */
export interface AuditLog {
  record(text: string): void;
}
