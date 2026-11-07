<?php

namespace App\Repositories;

use App\Domain\Order;
use Illuminate\Support\Facades\DB;

class EloquentOrderRepository implements OrderRepositoryContract
{
    public function findUser(int $id): ?array
    {
        return DB::table('users')->where('id', $id)->first();
    }

    public function reserve(string $sku): void
    {
        DB::table('stock')->where('sku', $sku)->decrement('qty');
    }

    public function save(Order $order): Order
    {
        DB::table('orders')->insert($order->toArray());
        return $order;
    }
}
