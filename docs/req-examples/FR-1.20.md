# FR-1.20 — React child components as messages (TSX)

```tsx
const _OrderRow = ({ order }: { order: Order }) => <li>{order.number}</li>;
export const OrderRow = observer(_OrderRow);

export function OrderList({ orderIds, ...rest }: Props) {
  const orders = useOrders(orderIds);
  return (
    <Styled.Wrapper {...rest}>
      <h2>Orders</h2>
      {orders.length === 0 && <EmptyState />}
      <ul>{orders.map((o) => <OrderRow order={o} />)}</ul>
    </Styled.Wrapper>
  );
}
```

`OrderList` sends `useOrders(orderIds)`, `«render» EmptyState()` in `opt [orders.length === 0]` and
`«render» OrderRow(order)` in `loop [each o of orders]`. `Styled.Wrapper`, `h2`, `ul`, `li` are not drawn.
*Show callers* of `OrderRow` lists `OrderList`.
