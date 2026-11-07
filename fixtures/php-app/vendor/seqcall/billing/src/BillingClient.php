<?php

namespace Seqcall\Billing;

use Illuminate\Support\Facades\Http;

class BillingClient
{
    public function invoice(int $userId, int $amount): Invoice
    {
        Http::post('https://billing.example/invoices', ['user' => $userId, 'amount' => $amount]);
        return new Invoice($userId, $amount);
    }
}
