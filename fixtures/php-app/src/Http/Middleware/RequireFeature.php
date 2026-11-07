<?php

namespace App\Http\Middleware;

use App\Support\Features;
use Closure;

/** Lets a request through only while a feature is on; otherwise answers with the given code. */
class RequireFeature
{
    public function __construct(private Features $features)
    {
    }

    public function handle($request, Closure $next, string $feature, string $code)
    {
        if ($this->features->enabled($feature)) {
            return $next($request);
        }

        return response()->json(['error' => 'disabled'], (int) $code);
    }
}
