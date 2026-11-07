<?php

namespace App\Notifications;

use Illuminate\Support\Facades\Mail;

class EmailNotifier extends BaseNotifier
{
    protected function channel(): Channel
    {
        return new MailChannel();
    }
}

class MailChannel implements Channel
{
    public function send(string $to, string $text): void
    {
        Mail::raw($text, fn ($m) => $m->to($to));
    }
}
