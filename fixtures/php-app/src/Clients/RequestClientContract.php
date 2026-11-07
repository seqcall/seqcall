<?php

namespace App\Clients;

interface RequestClientContract
{
    public function send(string $path): string;
}
