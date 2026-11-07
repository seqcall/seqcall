// A back-reference: Order hands itself to Pricing, which calls it back on the same object
// (FR-19.4 cyclic collaboration through one object, Order → Pricing → Order).
export class Pricing {
  price(order: Order): number {
    return order.items() * 10;
  }

  /** Two orders created and called on the spot: each call goes to the order just created. */
  quote(): number {
    return new Order(this).total() + new Order(this).items();
  }

  /** Two orders only created (never called here): still two objects. */
  drafts(): Order[] {
    return [new Order(this), new Order(this)];
  }
}

export class Order {
  constructor(private readonly pricing: Pricing) {}

  items(): number {
    return 3;
  }

  total(): number {
    return this.pricing.price(this);
  }
}
