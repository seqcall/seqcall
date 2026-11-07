<?php

namespace App\Providers;

use App\Http\Controllers\RefundController;
use App\Http\Middleware\RequireFeature;
use App\Http\Middleware\VerifySignature;
use App\Support\Features;
use Illuminate\Foundation\Support\Providers\RouteServiceProvider as ServiceProvider;
use Illuminate\Support\Facades\Route;

class RouteServiceProvider extends ServiceProvider
{
    protected $namespace = 'App\Http\Controllers';

    public function boot(): void
    {
        Route::prefix('api')->middleware('api')->namespace($this->namespace)->group(base_path('routes/api.php'));
        $this->refundRoutes();
    }

    /** FR-18.14 middleware on a group and on routes: after and before the verb, the action's key, a helper, exclusions. */
    private function refundRoutes(): void
    {
        Route::prefix('api/refunds')->middleware('api')->group(function () {
            Route::post('', [RefundController::class, 'store'])->name('refunds.store')->middleware([self::feature('403'), VerifySignature::class, 'auth', 'auth'])->withoutMiddleware('auth');
            Route::middleware('throttle:10,1')->post('{id}/retry', [RefundController::class, 'retry']);
            Route::get('{id}', ['uses' => '\App\Http\Controllers\RefundController@show', 'middleware' => 'cache.headers:max_age=60']);
        });
    }

    /** The middleware gating a refund route on its feature, answering $code while it is off. */
    private static function feature(string $code): string
    {
        return RequireFeature::class . ':' . Features::REFUNDS . ',' . $code;
    }
}
