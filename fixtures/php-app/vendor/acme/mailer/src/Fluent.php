<?php

namespace Acme\Mailer;

abstract class Fluent
{
    /**
     * @return static
     */
    public function to(string $address)
    {
        return $this;
    }
}
