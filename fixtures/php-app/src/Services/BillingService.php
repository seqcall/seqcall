<?php

namespace App\Services;

use Acme\Mailer\Mailer;
use App\Domain\Order;
use Seqcall\Billing\BillingClient;
use Seqcall\Billing\Contracts\Ledger;

class BillingService
{
    public function __construct(
        private BillingClient $billing,
        private Ledger $ledger,
        private Mailer $mailer,
    ) {
    }

    public function bill(int $userId, int $amount): void
    {
        $invoice = $this->billing->invoice($userId, $amount);
        $this->ledger->record($invoice);
        $this->mailer->send('billed');
    }

    /** Two orders created and called on the spot: each call goes to the order just created. */
    public function quote(): array
    {
        return [(new Order(1, 2, 'a'))->toArray(), (new Order(3, 4, 'b'))->toArray()];
    }

    /** The same, one level down (the creations are expanded below this call). */
    public function quoteAll(): array
    {
        return $this->quote();
    }

    public function notify(bool $urgent): void
    {
        if ($urgent) {
            $envelope = $this->mailer->envelope()->to('ops')->cc('boss');
        } else {
            $envelope = $this->mailer->envelope()->first();
        }
        $envelope->build()->deliver();
    }
}
