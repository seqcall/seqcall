import type { QuoteSource } from '../ports/quote-source';
import { QuoteClient } from '../clients/quote-client';

/** Implements the port, does no I/O itself: the client it holds does (FR-7.10). */
export class HttpQuotes implements QuoteSource {
  constructor(private readonly client: QuoteClient) {}

  async latest(symbol: string): Promise<number> {
    return Number(await this.client.get(symbol));
  }
}
