<?php

namespace Seqcall\Billing\Http;

use Seqcall\Billing\BillingClient;

class WebhookController
{
    public function __construct(private BillingClient $billing)
    {
    }

    /** Calls a method of its own package: a caller found inside the package (FR-4.1). */
    public function receive(): void
    {
        $this->billing->invoice(0, 0);
    }

    public function status(): string
    {
        return 'ok';
    }
}
