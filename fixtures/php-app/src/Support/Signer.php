<?php

namespace App\Support;

class Signer
{
    public function verify(?string $signature, string $body): bool
    {
        return hash_equals(hash_hmac('sha256', $body, (string) config('app.key')), (string) $signature);
    }
}
