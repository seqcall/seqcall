<?php

namespace App\Notifications;

interface Channel
{
    public function send(string $to, string $text): void;
}
