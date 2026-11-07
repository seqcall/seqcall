<?php

namespace Seqcall\Billing;

use Illuminate\Support\Facades\DB;
use Seqcall\Billing\Contracts\Ledger;

class DbLedger implements Ledger
{
    public function record(Invoice $invoice): void
    {
        DB::table('ledger')->insert(['user' => $invoice->userId, 'amount' => $invoice->amount]);
    }
}
