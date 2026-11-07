<?php

namespace App\Services;

use App\Clients\RequestClientContract;
use App\Domain\Order;

class QuoteService
{
    public function __construct(private RequestClientContract $client)
    {
    }

    public function quote(): string
    {
        return $this->client->send('/quotes');
    }

    /** FR-5.6 creations that exclude each other: early returns, then two that coexist. */
    public function draft(int $amount): Order
    {
        if ($amount < 0) {
            return new Order(0, 0, 'negative');
        }
        if ($amount === 0) {
            return new Order(0, 0, 'zero');
        }
        $order = new Order(1, $amount, 'draft');
        $copy = new Order(1, $amount, 'copy');
        return $order;
    }

    /** FR-5.7 every return creates an Order: the caller's $order is that object. */
    public function make(bool $vip): Order
    {
        if ($vip) {
            return new Order(1, 100, 'vip');
        }
        return new Order(1, 10, 'plain');
    }

    public function confirm(bool $vip): array
    {
        $order = $this->make($vip);
        return $order->toArray();
    }

    /** FR-5.7 not bound: `return $existing` is no call, so the returned object is not known. */
    public function makeOrReuse(bool $fresh, Order $existing): Order
    {
        if ($fresh) {
            return new Order(1, 1, 'fresh');
        }
        return $existing;
    }

    public function confirmReuse(bool $fresh, Order $existing): array
    {
        $order = $this->makeOrReuse($fresh, $existing);
        return $order->toArray();
    }

    /** FR-5.6 one object per branch of an if / else. */
    public function pick(bool $vip): Order
    {
        if ($vip) {
            $order = new Order(1, 100, 'vip');
        } else {
            $order = new Order(1, 10, 'plain');
        }
        return $order;
    }

    /** FR-5.6 the try block's last call and each catch: only one of the three objects leaves the method. */
    public function load(): array
    {
        try {
            $text = $this->quote();
            return [$text, new Order(1, 1, 'ok')];
        } catch (\InvalidArgumentException $e) {
            return [null, new Order(0, 0, 'invalid')];
        } catch (\Exception $e) {
            return [null, new Order(0, 0, 'error')];
        }
    }

    /** FR-5.6 not merged: the try block goes on after the creation, so both objects may exist. */
    public function loadAndQuote(): array
    {
        try {
            $order = new Order(1, 1, 'ok');
            $text = $this->quote();
            return [$text, $order];
        } catch (\Exception $e) {
            return [null, new Order(0, 0, 'error')];
        }
    }

    /** FR-5.8 an array with a local variable: the caller destructures it and passes the order on. */
    private function placeOrder(bool $ok): array
    {
        if (!$ok) {
            return [null, 'invalid'];
        }
        $order = new Order(1, 1, 'joined');
        return [$order, 'ok'];
    }

    public function join(bool $ok): array
    {
        [$order, $status] = $this->placeOrder($ok);
        $this->audit($order);
        return [$status];
    }

    private function audit(Order $order): void
    {
        $order->toArray();
    }
}
