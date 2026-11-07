# FR-1.2 — a method seen through a mapped type (TypeScript)

```ts
type CancellableFn<A extends unknown[], R> = (...args: [...A, AbortSignal?]) => R;
type Cancellable<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? CancellableFn<A, R> : T[K] };

declare function withCancel<T>(api: T): Cancellable<T>;

class OrderApi {
  listOrders(customerId: string): Promise<Order[]> { /* … */ }
}

const orderApi = withCancel(new OrderApi());
orderApi.listOrders('c-1');
```

The call `orderApi.listOrders('c-1')` goes to `OrderApi.listOrders` (expandable, navigable), not to *unknown*,
although its type is `CancellableFn<…>`.
