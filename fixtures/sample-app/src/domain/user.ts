export class User {
  constructor(
    public readonly id: string,
    public name: string,
    public readonly email: string,
    public readonly managerId?: string,
  ) {}

  get displayName(): string {
    return this.name.trim();
  }

  rename(name: string): void {
    this.name = name.trim();
  }
}
