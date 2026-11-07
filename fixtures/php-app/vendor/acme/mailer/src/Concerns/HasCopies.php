<?php

namespace Acme\Mailer\Concerns;

trait HasCopies
{
    /**
     * @return $this
     */
    public function cc(string $address)
    {
        return $this;
    }
}
