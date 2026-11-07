<?php

namespace App\Domain;

enum OrderStatus: string
{
    case Placed = 'placed';
    case Paid = 'paid';
}
