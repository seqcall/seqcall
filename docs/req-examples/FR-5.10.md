# FR-5.10 — interchangeable objects on one lifeline (TSX)

```tsx
class PriceFormatter {                      // (a) no state of its own
  format(cents: number) { return (cents / 100).toFixed(2); }
}

class CartView {
  constructor(private readonly cart: CartStore) {}
  total() { return this.cart.total(); }
}

class CheckoutViewHandler {                 // (b) state only from constructor arguments
  readonly cartView: CartView;
  constructor(cart: CartStore) { this.cartView = new CartView(cart); }
}

function useCheckoutViewHandler() {         // (c) a hook handing out its fields
  const { cartStore } = rootStore;
  return useMemo(() => new CheckoutViewHandler(cartStore), [cartStore]);
}

function CartBadge() {
  const fmt = useMemo(() => new PriceFormatter(), []);
  const { cartView } = useCheckoutViewHandler();
  return <span>{fmt.format(cartView.total())}</span>;
}
function CartSummary() { /* the same two lines */ }
```

With both components expanded: one `:PriceFormatter ×2`, one `:CheckoutViewHandler ×2` and one `:CartView ×2`
lifeline; the components' `cartView.total()` calls go to that `:CartView`, not to a separate `cartView:CartView`.
