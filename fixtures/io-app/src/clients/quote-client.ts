/** A plain HTTP client (no interface in front of it): calls the global fetch. */
export class QuoteClient {
  async get(path: string): Promise<string> {
    const res = await fetch(`https://quotes.example/${path}`);
    return res.text();
  }
}
