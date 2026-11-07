<?php

namespace Acme\Mailer;

use Acme\Mailer\Concerns\HasCopies;

/**
 * A fluent builder: `@return static` through a trait and a base class, a template-typed `first()`.
 *
 * @template TValue
 */
class Envelope extends Fluent
{
    use HasCopies;

    /**
     * @return TValue|null
     */
    public function first()
    {
        return null;
    }

    public function build(): Message
    {
        return new Message();
    }
}
