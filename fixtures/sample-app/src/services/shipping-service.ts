import type { User } from '../domain/user';
import { ShippingPolicy } from '../domain/shipping-policy';

/** Calls the domain rule; references User only in its signature (FR-12.12). */
export class ShippingService {
  ship(user: User, weightKg: number): string {
    return ShippingPolicy.canShip(user, [{ weightKg }]) ? 'shipped' : 'rejected';
  }
}
