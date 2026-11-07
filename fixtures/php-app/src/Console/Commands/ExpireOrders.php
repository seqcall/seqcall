<?php

namespace App\Console\Commands;

use App\Repositories\EloquentOrderRepository;
use Illuminate\Console\Command;

class ExpireOrders extends Command
{
    protected $signature = 'orders:expire {--days=30}';

    /** An N+1 on purpose (FR-19 fixture): one query per user id. */
    public function handle(EloquentOrderRepository $orders): int
    {
        foreach ([1, 2, 3] as $userId) {
            $orders->findUser($userId);
        }
        return 0;
    }
}
