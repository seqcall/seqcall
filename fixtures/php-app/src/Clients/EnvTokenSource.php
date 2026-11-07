<?php

namespace App\Clients;

class EnvTokenSource implements TokenSource
{
    public function token(): string
    {
        return 'token';
    }
}
