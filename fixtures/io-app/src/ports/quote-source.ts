/** Port whose adapter delegates the HTTP to a concrete client (FR-7.10 delegating adapter). */
export interface QuoteSource {
  latest(symbol: string): Promise<number>;
}
