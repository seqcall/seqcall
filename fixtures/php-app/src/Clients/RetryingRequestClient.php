<?php

namespace App\Clients;

/** Inherits send(); overrides handle() (FR-8.6: the bound subclass runs its own handle). */
class RetryingRequestClient extends RequestClient
{
    protected function handle(\Closure $request): string
    {
        return parent::handle($request);
    }
}
