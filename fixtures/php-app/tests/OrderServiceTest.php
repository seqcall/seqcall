<?php

namespace Tests;

use App\Repositories\InMemoryOrderRepository;
use App\Services\OrderService;

class OrderServiceTest extends TestCase
{
    public function test_places_an_order(OrderService $service): void
    {
        $service->placeOrder(1, [['sku' => 'a', 'qty' => 1]]);
        (new InMemoryOrderRepository())->findUser(1);
    }

    /** @test */
    public function it_rejects_unknown_users(): void
    {
    }

    private function helper(): void
    {
    }
}
