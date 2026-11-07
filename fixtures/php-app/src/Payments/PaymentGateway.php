<?php

namespace App\Payments;

interface PaymentGateway
{
    public function charge(int $userId, int $amount): string;
}
