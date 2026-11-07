import { Archiver } from '../services/archiver';
import { NoteService } from '../services/note-service';

export class NoteController {
  constructor(
    private readonly service: NoteService,
    private readonly archiver: Archiver,
  ) {}

  async show(id: string): Promise<string> {
    const text = await this.service.load(id);
    return this.service.shout(text);
  }

  async share(id: string): Promise<number> {
    return this.service.publish(id);
  }

  async archive(id: string): Promise<void> {
    await this.archiver.run(id);
  }
}
