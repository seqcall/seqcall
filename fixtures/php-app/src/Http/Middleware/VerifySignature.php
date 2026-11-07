<?php

namespace App\Http\Middleware;

use App\Support\Signer;
use Closure;

/** Refuses a request whose signature header does not match its body. */
class VerifySignature
{
    public function __construct(private Signer $signer)
    {
    }

    public function handle($request, Closure $next)
    {
        if (! $this->signer->verify($request->header('X-Signature'), $request->getContent())) {
            return response()->json(['error' => 'bad signature'], 401);
        }

        return $next($request);
    }
}
