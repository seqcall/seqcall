<?php

namespace App\Http\Controllers\Admin;

class StatsController
{
    public function show(string $day): array
    {
        return [$day];
    }

    public function refresh(): void
    {
    }
}
