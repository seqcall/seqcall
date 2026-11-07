/** Configuration in an outer layer (fixture, FR-12.12): read by a domain rule — a hidden dependency. */
export enum Tier {
  Standard = 'standard',
  Express = 'express',
  Blocked = 'blocked',
}

export const MAX_PARCEL_KG = 30;

export interface Parcel {
  weightKg: number;
}
