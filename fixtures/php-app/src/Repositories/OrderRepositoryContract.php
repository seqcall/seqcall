<?php

namespace App\Repositories;

use App\Domain\Order;

interface OrderRepositoryContract
{
    public function findUser(int $id): ?array;

    public function reserve(string $sku): void;

    public function save(Order $order): Order;
}
