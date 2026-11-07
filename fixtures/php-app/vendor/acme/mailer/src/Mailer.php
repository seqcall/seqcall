<?php

namespace Acme\Mailer;

class Mailer
{
    public function send(string $text): void
    {
    }

    public function envelope(): Envelope
    {
        return new Envelope();
    }
}
