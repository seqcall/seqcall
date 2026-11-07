<?php

namespace App\Domain;

final class Pricing
{
    public static function priceOf(string $sku, int $qty): int
    {
        return self::unitPrice($sku) * $qty;
    }

    private static function unitPrice(string $sku): int
    {
        return strlen($sku);
    }
}
