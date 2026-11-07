<?php

namespace App\Support;

class Features
{
    public const REFUNDS = 'refunds';

    public function enabled(string $feature): bool
    {
        return (bool) config("features.$feature", false);
    }
}
