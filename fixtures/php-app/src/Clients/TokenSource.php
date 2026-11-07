<?php

namespace App\Clients;

interface TokenSource
{
    public function token(): string;
}
