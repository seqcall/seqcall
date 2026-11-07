<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Account extends Model
{
    public function credit(int $points): bool
    {
        return $this->increment('points', $points) > 0;
    }
}
