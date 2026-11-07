import { MAX_PARCEL_KG, Tier, type Parcel } from '../infrastructure/shipping-config';
import type { User } from './user';

/** Domain rule that only *uses* outer-layer types (enum, const, generic argument): no calls (FR-12.12). */
export class ShippingPolicy {
  static canShip(user: User, parcels: Array<Parcel>): boolean {
    const tier = user.email.endsWith('.blocked') ? Tier.Blocked : (user.email as string).length > 20 ? Tier.Express : Tier.Standard;
    return tier !== Tier.Blocked && parcels.every((p) => p.weightKg <= MAX_PARCEL_KG) && ShippingPolicy.label(tier) !== '';
  }

  static label(tier: string): string {
    return tier.toUpperCase();
  }
}
