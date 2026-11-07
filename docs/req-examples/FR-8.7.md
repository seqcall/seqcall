# FR-8.7 — the container builds the object graph first (PHP / Laravel)

```php
class OrdersController
{
    public function __construct(private OrderService $order_service) {}
    public function show(int $id) { return $this->order_service->find($id); }
}

interface OrderRepository { public function find(int $id): ?Order; }

class OrderService
{
    public function __construct(private OrderRepository $repository, private PriceCalculator $prices) {}
}

// AppServiceProvider::register()
$this->app->bind(OrderRepository::class, EloquentOrderRepository::class);
```

The diagram of `OrdersController::show` starts with a collapsed `● resolve(OrdersController::class)` to
`:Container`. Expanded: `repository = «create» EloquentOrderRepository()`, `prices = «create» PriceCalculator()`,
`order_service = «create» OrderService()` (dependencies before their consumers) — the objects the flow then calls.
