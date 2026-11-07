<?php

namespace App\Clients;

class RequestClient implements RequestClientContract
{
    public function __construct(private TokenSource $tokens)
    {
    }

    public function send(string $path): string
    {
        $this->tokens->token();
        return $this->handle(fn () => $path);
    }

    protected function handle(\Closure $request): string
    {
        return $request();
    }
}
