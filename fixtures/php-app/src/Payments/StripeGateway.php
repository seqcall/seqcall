<?php

namespace App\Payments;

use Illuminate\Support\Facades\Http;

class StripeGateway implements PaymentGateway
{
    public function charge(int $userId, int $amount): string
    {
        $response = Http::withToken('secret')->post('https://stripe.example/charges', ['user' => $userId, 'amount' => $amount]);
        if ($response->failed()) {
            throw new PaymentFailed('charge failed');
        }
        return $response->json('id');
    }
}
