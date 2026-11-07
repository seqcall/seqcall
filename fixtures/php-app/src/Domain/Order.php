<?php

namespace App\Domain;

class Order
{
    private ?OrderStatus $status = null;

    public function __construct(
        public readonly int $userId,
        public readonly int $total,
        public readonly string $receipt,
    ) {
    }

    public static function empty(): static
    {
        return new static(0, 0, '');
    }

    public function withStatus(OrderStatus $status): static
    {
        $copy = clone $this;
        $copy->status = $status;
        return $copy;
    }

    public function toArray(): array
    {
        return ['user' => $this->userId, 'total' => money_format($this->total)];
    }
}
