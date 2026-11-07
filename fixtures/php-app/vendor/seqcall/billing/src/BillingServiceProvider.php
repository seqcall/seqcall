<?php

namespace Seqcall\Billing;

use Illuminate\Support\Facades\Route;
use Seqcall\Billing\Http\WebhookController;

/** A package that registers its own routes (FR-18.11 A): the project does not mount them. */
class BillingServiceProvider
{
    public function boot(): void
    {
        $this->registerRoutes();
    }

    private function registerRoutes(): void
    {
        Route::namespace('\Seqcall\Billing\Http')->prefix('api/billing')->group(function () {
            Route::post('webhook', 'WebhookController@receive');
            Route::get('status', [WebhookController::class, 'status']);
        });
    }
}
