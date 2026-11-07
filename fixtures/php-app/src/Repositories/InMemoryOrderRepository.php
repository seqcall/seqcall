<?php

namespace App\Repositories;

use App\Domain\Order;

class InMemoryOrderRepository implements OrderRepositoryContract
{
    /** @var array<int, array> */
    private array $users = [];

    public function findUser(int $id): ?array
    {
        return $this->users[$id] ?? null;
    }

    public function reserve(string $sku): void
    {
    }

    public function save(Order $order): Order
    {
        return $order;
    }
}
