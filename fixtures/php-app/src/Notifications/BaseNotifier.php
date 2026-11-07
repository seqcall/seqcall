<?php

namespace App\Notifications;

abstract class BaseNotifier
{
    public function notify(array $user, string $message): void
    {
        $this->channel()->send($user['email'], $this->format($message));
    }

    abstract protected function channel(): Channel;

    protected function format(string $message): string
    {
        return trim($message);
    }
}
