<?php

namespace Seqcall\Billing\Contracts;

use Seqcall\Billing\Invoice;

interface Ledger
{
    public function record(Invoice $invoice): void;
}
