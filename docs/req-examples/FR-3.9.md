# FR-3.9 — Smart expand follows the main path (TypeScript)

```ts
async placeOrder(cmd: PlaceOrder): Promise<Result<OrderId>> {
  const cart = await this.carts.load(cmd.cartId);
  if (!cart.isValid()) {
    await this.audit.rejected(cmd);                   // error path: failure check
    return Result.fail('invalid cart');
  }
  try {
    const invoice = await this.billing.charge(cart);  // main path
    await this.orders.save(Order.from(cart, invoice));
  } catch (e) {
    await this.compensation.refund(cart);             // error path: catch
    throw e;
  }
  if (cart.hasVoucher) await this.vouchers.redeem(cart); // business variant: stays on the path
  return Result.ok(cart.id);
}
```

✦ Smart opens `load`, `charge`, `save` and `redeem` and what they reveal. The two error branches fold into the
traces (FR-3.11): the guard clause into its exit marker `↩ [!cart.isValid()] ⊕ 1 call`, the catch into a marker
after the try block `⤷ [catch] ⊕ 1 call` (the try frame goes) — `rejected` and `refund` are not drawn until ⊕ is clicked. A guard clause folds whatever it
returns (`if (zone is null) return RejectUnknownZone();`), so does a branch that builds an error
(`return inStock ? reserved : Result.Failure(new OutOfStockError())`); the frames around them go. A method whose
only notable calls are in such branches is not worth opening for them. Expand all shows everything.

`if (cart.hasVoucher)` is a business variant, not an error: it stays. To read one variant at a time, right-click
its guard → *Follow this case* (FR-1.22).
