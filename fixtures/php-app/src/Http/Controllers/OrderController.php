<?php

namespace App\Http\Controllers;

use App\Services\OrderService;
use Illuminate\Http\Request;

class OrderController
{
    public function __construct(private OrderService $orders)
    {
    }

    public function store(Request $request): array
    {
        $order = $this->orders->placeOrder((int) $request->input('user'), $request->input('items', []));
        return $order->toArray();
    }
}
