<?php

namespace Seqcall\Billing;

class Invoice
{
    public function __construct(public int $userId, public int $amount)
    {
    }
}
