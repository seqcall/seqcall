<?php

namespace App\Providers;

use App\Clients\RequestClient;
use App\Clients\RequestClientContract;
use App\Clients\RetryingRequestClient;
use App\Payments\PaymentGateway;
use App\Payments\StripeGateway;
use App\Services\QuoteService;
use Illuminate\Support\ServiceProvider;

/** FR-8.6 container bindings: a global one, and a contextual one for QuoteService. */
class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(RequestClientContract::class, RequestClient::class);
        $this->app->singleton(PaymentGateway::class, StripeGateway::class);
        $this->app->when(QuoteService::class)->needs(RequestClientContract::class)->give(fn ($app) => $app->make(RetryingRequestClient::class));
    }
}
