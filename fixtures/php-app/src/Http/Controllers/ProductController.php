<?php

namespace App\Http\Controllers;

class ProductController
{
    public function index(): array
    {
        return [];
    }

    public function show(int $id): array
    {
        return [$id];
    }
}
